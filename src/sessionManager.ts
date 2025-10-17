import { Page, BrowserContext } from "@browserbasehq/stagehand";
import type { Config } from "../config.d.ts";
import type { Cookie } from "playwright-core";
import { createStagehandInstance } from "./stagehandStore.js";
import { clearScreenshotsForSession } from "./mcp/resources.js";
import type { BrowserSession } from "./types/types.js";

// Global state for managing browser sessions
const browsers = new Map<string, BrowserSession>();

// Keep track of the default session explicitly
let defaultBrowserSession: BrowserSession | null = null;

// Define a specific ID for the default session
export const defaultSessionId = `browserbase_session_main_${Date.now()}`;

// Keep track of the active session ID. Defaults to the main session.
let activeSessionId: string = defaultSessionId;

/**
 * Sets the active session ID.
 * @param id The ID of the session to set as active.
 */
export function setActiveSessionId(id: string): void {
  if (browsers.has(id) || id === defaultSessionId) {
    activeSessionId = id;
  } else {
    process.stderr.write(
      `[SessionManager] WARN - Set active session failed for non-existent ID: ${id}\n`,
    );
  }
}

/**
 * Gets the active session ID.
 * @returns The active session ID.
 */
export function getActiveSessionId(): string {
  return activeSessionId;
}

/**
 * Adds cookies to a browser context
 * @param context Playwright browser context
 * @param cookies Array of cookies to add
 */
export async function addCookiesToContext(
  context: BrowserContext,
  cookies: Cookie[],
): Promise<void> {
  if (!cookies || cookies.length === 0) {
    return;
  }

  try {
    process.stderr.write(
      `[SessionManager] Adding ${cookies.length} cookies to browser context\n`,
    );
    await context.addCookies(cookies);
    process.stderr.write(
      `[SessionManager] Successfully added cookies to browser context\n`,
    );
  } catch (error) {
    process.stderr.write(
      `[SessionManager] Error adding cookies to browser context: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
  }
}

/**
 * Sets the User-Agent for a browser page using both HTTP headers and script injection.
 * This provides the most complete user-agent override by ensuring both HTTP requests
 * and JavaScript navigator.userAgent return the custom value.
 *
 * @param page The Playwright page
 * @param userAgent The User-Agent string to set
 * @throws Error if both methods fail (logs warnings for individual failures)
 */
export async function setUserAgent(
  page: Page,
  userAgent: string,
): Promise<void> {
  const sessionInfo = "[SessionManager]";
  let httpHeaderSuccess = false;
  let scriptInjectionSuccess = false;

  // Method 1: Set HTTP header for all requests
  try {
    await page.setExtraHTTPHeaders({
      "User-Agent": userAgent,
    });
    httpHeaderSuccess = true;
    process.stderr.write(
      `${sessionInfo} Set User-Agent HTTP header: ${userAgent.substring(0, 50)}...\n`,
    );
  } catch (error) {
    process.stderr.write(
      `${sessionInfo} Warning: Failed to set User-Agent header: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
  }

  // Method 2: Inject script to override navigator.userAgent
  try {
    // Escape single quotes in user agent string
    const escapedUA = userAgent.replace(/'/g, "\\'");

    const script = `
      // Override navigator.userAgent
      Object.defineProperty(navigator, 'userAgent', {
        get: () => '${escapedUA}',
        configurable: true
      });
    `;

    await page.addInitScript(script);
    scriptInjectionSuccess = true;
    process.stderr.write(
      `${sessionInfo} Injected User-Agent script for navigator.userAgent\n`,
    );
  } catch (error) {
    process.stderr.write(
      `${sessionInfo} Warning: Failed to inject User-Agent script: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
  }

  // If both methods failed, throw an error
  if (!httpHeaderSuccess && !scriptInjectionSuccess) {
    throw new Error(
      "Failed to set User-Agent: Both HTTP header and script injection methods failed",
    );
  }

  // Log success message
  if (httpHeaderSuccess && scriptInjectionSuccess) {
    process.stderr.write(
      `${sessionInfo} Successfully set User-Agent using both HTTP headers and script injection\n`,
    );
  } else if (httpHeaderSuccess) {
    process.stderr.write(
      `${sessionInfo} Partially set User-Agent: HTTP headers only (script injection failed)\n`,
    );
  } else {
    process.stderr.write(
      `${sessionInfo} Partially set User-Agent: Script injection only (HTTP headers failed)\n`,
    );
  }
}

// Function to create a new Browserbase session using Stagehand
export async function createNewBrowserSession(
  newSessionId: string,
  config: Config,
  resumeSessionId?: string,
  userAgent?: string,
): Promise<BrowserSession> {
  if (!config.browserbaseApiKey) {
    throw new Error("Browserbase API Key is missing in the configuration.");
  }
  if (!config.browserbaseProjectId) {
    throw new Error("Browserbase Project ID is missing in the configuration.");
  }

  try {
    process.stderr.write(
      `[SessionManager] ${resumeSessionId ? "Resuming" : "Creating"} Stagehand session ${newSessionId}...\n`,
    );

    // Create and initialize Stagehand instance using shared function
    const stagehand = await createStagehandInstance(
      config,
      {
        ...(resumeSessionId && { browserbaseSessionID: resumeSessionId }),
      },
      newSessionId,
    );

    // Get the page and browser from Stagehand
    const page = stagehand.page as unknown as Page;
    const browser = page.context().browser();

    if (!browser) {
      throw new Error("Failed to get browser from Stagehand page context");
    }

    const browserbaseSessionId = stagehand.browserbaseSessionID;

    process.stderr.write(
      `[SessionManager] Stagehand initialized with Browserbase session: ${browserbaseSessionId}\n`,
    );
    process.stderr.write(
      `[SessionManager] Browserbase Live Debugger URL: https://www.browserbase.com/sessions/${browserbaseSessionId}\n`,
    );

    // Set up disconnect handler
    browser.on("disconnected", () => {
      process.stderr.write(`[SessionManager] Disconnected: ${newSessionId}\n`);
      browsers.delete(newSessionId);
      if (defaultBrowserSession && defaultBrowserSession.browser === browser) {
        process.stderr.write(
          `[SessionManager] Disconnected (default): ${newSessionId}\n`,
        );
        defaultBrowserSession = null;
      }
      if (
        activeSessionId === newSessionId &&
        newSessionId !== defaultSessionId
      ) {
        process.stderr.write(
          `[SessionManager] WARN - Active session disconnected, resetting to default: ${newSessionId}\n`,
        );
        setActiveSessionId(defaultSessionId);
      }

      // Purge any screenshots associated with both internal and Browserbase IDs
      try {
        clearScreenshotsForSession(newSessionId);
        const bbId = browserbaseSessionId;
        if (bbId) {
          clearScreenshotsForSession(bbId);
        }
      } catch (err) {
        process.stderr.write(
          `[SessionManager] WARN - Failed to clear screenshots on disconnect for ${newSessionId}: ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        );
      }
    });

    // Apply user-agent if provided via tool parameter
    if (userAgent) {
      try {
        await setUserAgent(page, userAgent);
        process.stderr.write(
          `[SessionManager] Applied User-Agent for session: ${newSessionId}\n`,
        );
      } catch (error) {
        process.stderr.write(
          `[SessionManager] Failed to set User-Agent for session ${newSessionId}: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        );
        // Don't throw - session can still be used
      }
    }

    // Add cookies to the context if they are provided in the config
    if (
      config.cookies &&
      Array.isArray(config.cookies) &&
      config.cookies.length > 0
    ) {
      await addCookiesToContext(
        page.context() as BrowserContext,
        config.cookies,
      );
    }

    const sessionObj: BrowserSession = {
      browser,
      page,
      sessionId: browserbaseSessionId!,
      stagehand,
    };

    browsers.set(newSessionId, sessionObj);

    if (newSessionId === defaultSessionId) {
      defaultBrowserSession = sessionObj;
    }

    setActiveSessionId(newSessionId);
    process.stderr.write(
      `[SessionManager] Session created and active: ${newSessionId}\n`,
    );

    return sessionObj;
  } catch (creationError) {
    const errorMessage =
      creationError instanceof Error
        ? creationError.message
        : String(creationError);
    process.stderr.write(
      `[SessionManager] Creating session ${newSessionId} failed: ${errorMessage}\n`,
    );
    throw new Error(
      `Failed to create/connect session ${newSessionId}: ${errorMessage}`,
    );
  }
}

async function closeBrowserGracefully(
  session: BrowserSession | undefined | null,
  sessionIdToLog: string,
): Promise<void> {
  // Close Stagehand instance which handles browser cleanup
  if (session?.stagehand) {
    try {
      process.stderr.write(
        `[SessionManager] Closing Stagehand for session: ${sessionIdToLog}\n`,
      );
      await session.stagehand.close();
      process.stderr.write(
        `[SessionManager] Successfully closed Stagehand and browser for session: ${sessionIdToLog}\n`,
      );
      // After close, purge any screenshots associated with both internal and Browserbase IDs
      try {
        clearScreenshotsForSession(sessionIdToLog);
        const bbId = session?.stagehand?.browserbaseSessionID;
        if (bbId) {
          clearScreenshotsForSession(bbId);
        }
      } catch (err) {
        process.stderr.write(
          `[SessionManager] WARN - Failed to clear screenshots after close for ${sessionIdToLog}: ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        );
      }
    } catch (closeError) {
      process.stderr.write(
        `[SessionManager] WARN - Error closing Stagehand for session ${sessionIdToLog}: ${
          closeError instanceof Error ? closeError.message : String(closeError)
        }\n`,
      );
    }
  }
}

// Internal function to ensure default session
export async function ensureDefaultSessionInternal(
  config: Config,
  userAgent?: string,
): Promise<BrowserSession> {
  const sessionId = defaultSessionId;
  let needsReCreation = false;

  if (!defaultBrowserSession) {
    needsReCreation = true;
    process.stderr.write(
      `[SessionManager] Default session ${sessionId} not found, creating.\n`,
    );
  } else if (
    !defaultBrowserSession.browser.isConnected() ||
    defaultBrowserSession.page.isClosed()
  ) {
    needsReCreation = true;
    process.stderr.write(
      `[SessionManager] Default session ${sessionId} is stale, recreating.\n`,
    );
    await closeBrowserGracefully(defaultBrowserSession, sessionId);
    defaultBrowserSession = null;
    browsers.delete(sessionId);
  }

  if (needsReCreation) {
    try {
      defaultBrowserSession = await createNewBrowserSession(
        sessionId,
        config,
        undefined,
        userAgent,
      );
      return defaultBrowserSession;
    } catch (creationError) {
      // Error during initial creation or recreation
      process.stderr.write(
        `[SessionManager] Initial/Recreation attempt for default session ${sessionId} failed. Error: ${
          creationError instanceof Error
            ? creationError.message
            : String(creationError)
        }\n`,
      );
      // Attempt one more time after a failure
      process.stderr.write(
        `[SessionManager] Retrying creation of default session ${sessionId} after error...\n`,
      );
      try {
        defaultBrowserSession = await createNewBrowserSession(
          sessionId,
          config,
          undefined,
          userAgent,
        );
        return defaultBrowserSession;
      } catch (retryError) {
        const finalErrorMessage =
          retryError instanceof Error ? retryError.message : String(retryError);
        process.stderr.write(
          `[SessionManager] Failed to recreate default session ${sessionId} after retry: ${finalErrorMessage}\n`,
        );
        throw new Error(
          `Failed to ensure default session ${sessionId} after initial error and retry: ${finalErrorMessage}`,
        );
      }
    }
  }

  // If we reached here, the existing default session is considered okay.
  setActiveSessionId(sessionId); // Ensure default is marked active
  return defaultBrowserSession!; // Non-null assertion: logic ensures it's not null here
}

// Get a specific session by ID
export async function getSession(
  sessionId: string,
  config: Config,
  createIfMissing: boolean = true,
): Promise<BrowserSession | null> {
  if (sessionId === defaultSessionId && createIfMissing) {
    try {
      return await ensureDefaultSessionInternal(config);
    } catch {
      process.stderr.write(
        `[SessionManager] Failed to get default session due to error in ensureDefaultSessionInternal for ${sessionId}. See previous messages for details.\n`,
      );
      return null; // Or rethrow if getSession failing for default is critical
    }
  }

  // For non-default sessions
  process.stderr.write(`[SessionManager] Getting session: ${sessionId}\n`);
  const sessionObj = browsers.get(sessionId);

  if (!sessionObj) {
    process.stderr.write(
      `[SessionManager] WARN - Session not found in map: ${sessionId}\n`,
    );
    return null;
  }

  // Validate the found session
  if (!sessionObj.browser.isConnected() || sessionObj.page.isClosed()) {
    process.stderr.write(
      `[SessionManager] WARN - Found session ${sessionId} is stale, removing.\n`,
    );
    await closeBrowserGracefully(sessionObj, sessionId);
    browsers.delete(sessionId);
    if (activeSessionId === sessionId) {
      process.stderr.write(
        `[SessionManager] WARN - Invalidated active session ${sessionId}, resetting to default.\n`,
      );
      setActiveSessionId(defaultSessionId);
    }
    return null;
  }

  // Session appears valid, make it active
  setActiveSessionId(sessionId);
  process.stderr.write(`[SessionManager] Using valid session: ${sessionId}\n`);
  return sessionObj;
}

/**
 * Clean up a session by removing it from tracking.
 * This is called after a browser is closed to ensure proper cleanup.
 * @param sessionId The session ID to clean up
 */
export async function cleanupSession(sessionId: string): Promise<void> {
  process.stderr.write(`[SessionManager] Cleaning up session: ${sessionId}\n`);

  // Get the session to close it gracefully
  const session = browsers.get(sessionId);
  if (session) {
    await closeBrowserGracefully(session, sessionId);
  }

  // Remove from browsers map
  browsers.delete(sessionId);

  // Always purge screenshots for this (internal) session id
  try {
    clearScreenshotsForSession(sessionId);
  } catch (err) {
    process.stderr.write(
      `[SessionManager] WARN - Failed to clear screenshots during cleanup for ${sessionId}: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
  }

  // Clear default session reference if this was the default
  if (sessionId === defaultSessionId && defaultBrowserSession) {
    defaultBrowserSession = null;
  }

  // Reset active session to default if this was the active one
  if (activeSessionId === sessionId) {
    process.stderr.write(
      `[SessionManager] Cleaned up active session ${sessionId}, resetting to default.\n`,
    );
    setActiveSessionId(defaultSessionId);
  }
}

// Function to close all managed browser sessions gracefully
export async function closeAllSessions(): Promise<void> {
  process.stderr.write(`[SessionManager] Closing all sessions...\n`);
  const closePromises: Promise<void>[] = [];
  for (const [id, session] of browsers.entries()) {
    process.stderr.write(`[SessionManager] Closing session: ${id}\n`);
    closePromises.push(
      // Use the helper for consistent logging/error handling
      closeBrowserGracefully(session, id),
    );
  }
  try {
    await Promise.all(closePromises);
  } catch {
    // Individual errors are caught and logged by closeBrowserGracefully
    process.stderr.write(
      `[SessionManager] WARN - Some errors occurred during batch session closing. See individual messages.\n`,
    );
  }

  browsers.clear();
  defaultBrowserSession = null;
  setActiveSessionId(defaultSessionId); // Reset active session to default
  process.stderr.write(`[SessionManager] All sessions closed and cleared.\n`);
}
