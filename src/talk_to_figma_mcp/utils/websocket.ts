import WebSocket from "ws";
import { v4 as uuidv4 } from "uuid";
import { logger } from "./logger";
import { serverUrl, defaultPort, WS_URL, reconnectInterval } from "../config/config";
import { FigmaCommand, FigmaResponse, CommandProgressUpdate, PendingRequest, ProgressMessage } from "../types";

// WebSocket connection and request tracking
let ws: WebSocket | null = null;
let currentChannel: string | null = null;
let keepaliveInterval: ReturnType<typeof setInterval> | null = null;

// Map of pending requests for promise tracking
const pendingRequests = new Map<string, PendingRequest>();

// Per-command timeout overrides (ms). Commands not listed use DEFAULT_TIMEOUT.
const COMMAND_TIMEOUTS: Partial<Record<FigmaCommand, number>> = {
  // Simple reads — in-memory state, should complete in <1s
  get_document_info: 10000,
  get_selection: 10000,
  get_pages: 10000,
  get_styles: 10000,
  get_node_info: 10000,
  get_nodes_info: 15000,
  get_local_components: 15000,
  get_remote_components: 15000,
  get_variables: 10000,
  get_figjam_elements: 10000,
  get_grid: 10000,
  get_guide: 10000,
  get_annotation: 10000,
  get_styled_text_segments: 10000,
  get_image_from_node: 15000,
  ping: 5000,
  join: 10000,
  // Heavy operations — keep long timeout
  export_node_as_image: 120000,
  scan_text_nodes: 120000,
  set_multiple_text_contents: 120000,
  get_svg: 60000,
  set_svg: 60000,
};
const DEFAULT_TIMEOUT = 30000; // 30s, down from 60s

/**
 * Connects to the Figma server via WebSocket.
 * @param port - Optional port for the connection (defaults to defaultPort from config)
 */
export function connectToFigma(port: number = defaultPort) {
  // If already connected, do nothing
  if (ws && ws.readyState === WebSocket.OPEN) {
    logger.info('Already connected to Figma');
    return;
  }

  // If connection is in progress (CONNECTING state), wait
  if (ws && ws.readyState === WebSocket.CONNECTING) {
    logger.info('Connection to Figma is already in progress');
    return;
  }

  // If there's an existing socket in a closing state, clean it up
  if (ws && (ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED)) {
    ws.removeAllListeners();
    ws = null;
  }

  const wsUrl = serverUrl === 'localhost' ? `${WS_URL}:${port}` : WS_URL;
  logger.info(`Connecting to Figma socket server at ${wsUrl}...`);
  
  try {
    ws = new WebSocket(wsUrl);
    
    // Add connection timeout
    const connectionTimeout = setTimeout(() => {
      if (ws && ws.readyState === WebSocket.CONNECTING) {
        logger.error('Connection to Figma timed out');
        ws.terminate();
      }
    }, 10000); // 10 second connection timeout
    
    ws.on('open', () => {
      clearTimeout(connectionTimeout);
      logger.info('Connected to Figma socket server');
      // Reset channel on new connection
      currentChannel = null;

      // Start keepalive ping every 30s to prevent idle disconnection
      if (keepaliveInterval) clearInterval(keepaliveInterval);
      keepaliveInterval = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.ping();
        }
      }, 30000);
    });

    ws.on("message", (data: any) => {
      try {
        const json = JSON.parse(data) as ProgressMessage;

        // Handle progress updates
        if (json.type === 'progress_update') {
          const progressData = json.message.data as CommandProgressUpdate;
          const requestId = json.id || '';

          if (requestId && pendingRequests.has(requestId)) {
            const request = pendingRequests.get(requestId)!;

            // Update last activity timestamp
            request.lastActivity = Date.now();

            // Reset the timeout to prevent timeouts during long-running operations
            clearTimeout(request.timeout);

            // Create a new timeout with extended time for long operations
            request.timeout = setTimeout(() => {
              if (pendingRequests.has(requestId)) {
                logger.error(`Request ${requestId} timed out after extended period of inactivity`);
                pendingRequests.delete(requestId);
                request.reject(new Error('Request to Figma timed out'));
              }
            }, 120000); // 120 second timeout for inactivity during progress updates

            // Log progress
            logger.info(`Progress update for ${progressData.commandType}: ${progressData.progress}% - ${progressData.message}`);

            // For completed updates, we could resolve the request early if desired
            if (progressData.status === 'completed' && progressData.progress === 100) {
              // Optionally resolve early with partial data
              // request.resolve(progressData.payload);
              // pendingRequests.delete(requestId);

              // Instead, just log the completion, wait for final result from Figma
              logger.info(`Operation ${progressData.commandType} completed, waiting for final result`);
            }
          }
          return;
        }

        // Handle regular responses
        const myResponse = json.message;
        logger.debug(`Received message: ${JSON.stringify(myResponse)}`);

        // Skip command echoes (own messages broadcast back to sender)
        if (myResponse.command) {
          return;
        }

        // Handle response to a request (success or error)
        if (
          myResponse.id &&
          pendingRequests.has(myResponse.id)
        ) {
          const request = pendingRequests.get(myResponse.id)!;
          clearTimeout(request.timeout);

          // Check for error at root level or nested inside result
          const error = myResponse.error ?? (myResponse.result && myResponse.result.error);

          if (error) {
            logger.error(`Error from Figma: ${error}`);
            request.reject(new Error(String(error)));
          } else {
            request.resolve(myResponse.result ?? myResponse);
          }

          pendingRequests.delete(myResponse.id);
        } else {
          // Handle broadcast messages or events
          logger.info(`Received broadcast message: ${JSON.stringify(myResponse)}`);
        }
      } catch (error) {
        logger.error(`Error parsing message: ${error instanceof Error ? error.message : String(error)}`);
      }
    });

    ws.on('error', (error) => {
      logger.error(`Socket error: ${error}`);
      // Don't attempt to reconnect here, let the close handler do it
    });

    ws.on('close', (code, reason) => {
      clearTimeout(connectionTimeout);
      if (keepaliveInterval) {
        clearInterval(keepaliveInterval);
        keepaliveInterval = null;
      }
      logger.info(`Disconnected from Figma socket server with code ${code} and reason: ${reason || 'No reason provided'}`);
      ws = null;

      // Reject all pending requests
      for (const [id, request] of pendingRequests.entries()) {
        clearTimeout(request.timeout);
        request.reject(new Error(`Connection closed with code ${code}: ${reason || 'No reason provided'}`));
        pendingRequests.delete(id);
      }

      // Attempt to reconnect with exponential backoff
      const backoff = Math.min(30000, reconnectInterval * Math.pow(1.5, Math.floor(Math.random() * 5))); // Max 30s
      logger.info(`Attempting to reconnect in ${backoff/1000} seconds...`);
      setTimeout(() => connectToFigma(port), backoff);
    });
    
  } catch (error) {
    logger.error(`Failed to create WebSocket connection: ${error instanceof Error ? error.message : String(error)}`);
    // Attempt to reconnect after a delay
    setTimeout(() => connectToFigma(port), reconnectInterval);
  }
}

/**
 * Join a specific channel in Figma.
 * @param channelName - Name of the channel to join
 * @returns Promise that resolves when successfully joined the channel
 */
export async function joinChannel(channelName: string): Promise<void> {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error("Not connected to Figma");
  }

  try {
    await sendCommandToFigma("join", { channel: channelName });
    currentChannel = channelName;

    try {
      await sendCommandToFigma("ping", {}, 12000);
      logger.info(`Joined channel: ${channelName}`);
    } catch (verificationError) {
      currentChannel = null;
      const errorMsg = verificationError instanceof Error
        ? verificationError.message
        : String(verificationError);
      logger.error(`Failed to verify channel ${channelName}: ${errorMsg}`);
      throw new Error(`Failed to verify connection to channel "${channelName}". The Figma plugin may not be connected to this channel.`);
    }
  } catch (error) {
    logger.error(`Failed to join channel: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

/**
 * Get the current channel the connection is joined to.
 * @returns The current channel name or null if not connected to any channel
 */
export function getCurrentChannel(): string | null {
  return currentChannel;
}

/**
 * Send a command to Figma via WebSocket.
 * @param command - The command to send
 * @param params - Additional parameters for the command
 * @param timeoutMs - Timeout in milliseconds before failing
 * @returns A promise that resolves with the Figma response
 */
export function sendCommandToFigma(
  command: FigmaCommand,
  params: unknown = {},
  timeoutMs?: number
): Promise<unknown> {
  const effectiveTimeout = timeoutMs ?? COMMAND_TIMEOUTS[command] ?? DEFAULT_TIMEOUT;

  return new Promise((resolve, reject) => {
    // If not connected, try to connect first
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      connectToFigma();
      reject(new Error(
        "Not connected to Figma bridge server. Attempting to reconnect... " +
        "Please wait a moment and try again, or check that the bridge server is running on port " + defaultPort
      ));
      return;
    }

    // Check if we need a channel for this command
    const requiresChannel = command !== "join";
    if (requiresChannel && !currentChannel) {
      reject(new Error("Must join a channel before sending commands. Use join_channel first."));
      return;
    }

    const id = uuidv4();
    const request = {
      id,
      type: command === "join" ? "join" : "message",
      ...(command === "join"
        ? { channel: (params as any).channel }
        : { channel: currentChannel }),
      message: {
        id,
        command,
        params: {
          ...(params as any),
          commandId: id, // Include the command ID in params
        },
      },
    };

    // Set timeout for request using per-command or default timeout
    const timeout = setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        logger.error(`Request ${id} ("${command}") timed out after ${effectiveTimeout / 1000} seconds`);
        reject(new Error(
          `Request "${command}" timed out after ${effectiveTimeout / 1000}s. ` +
          `The Figma plugin may be disconnected. Use get_connection_status to check.`
        ));
      }
    }, effectiveTimeout);

    // Store the promise callbacks to resolve/reject later
    pendingRequests.set(id, {
      resolve,
      reject,
      timeout,
      lastActivity: Date.now()
    });

    // Send the request
    logger.info(`Sending command to Figma: ${command} (timeout: ${effectiveTimeout / 1000}s)`);
    logger.debug(`Request details: ${JSON.stringify(request)}`);
    ws.send(JSON.stringify(request));
  });
}

/**
 * Check the health of the current channel by querying the bridge server's HTTP endpoint.
 * Returns connection state, channel name, and number of active clients.
 */
export async function checkChannelHealth(): Promise<{ connected: boolean; channel: string | null; clients: number }> {
  if (!currentChannel) {
    return { connected: false, channel: null, clients: 0 };
  }
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return { connected: false, channel: currentChannel, clients: 0 };
  }
  try {
    const host = serverUrl === 'localhost' ? 'localhost' : serverUrl;
    const url = `http://${host}:${defaultPort}/channels/${encodeURIComponent(currentChannel)}`;
    const resp = await fetch(url);
    const data = await resp.json() as { clients?: number };
    return { connected: true, channel: currentChannel, clients: data.clients ?? 0 };
  } catch {
    return { connected: true, channel: currentChannel, clients: -1 };
  }
}