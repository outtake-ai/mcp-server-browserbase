import { z } from "zod";
import type { Tool, ToolSchema, ToolResult } from "./tool.js";
import type { Context } from "../context.js";
import type { ToolActionResult } from "../types/types.js";
import { registerScreenshot } from "../mcp/resources.js";
import { getSession } from "../sessionManager.js";
import type { CDPSession } from "playwright-core";
import type { Page } from "@browserbasehq/stagehand";

const ScreenshotInputSchema = z.object({
  name: z.string().optional().describe("The name of the screenshot"),
});

type ScreenshotInput = z.infer<typeof ScreenshotInputSchema>;

const screenshotSchema: ToolSchema<typeof ScreenshotInputSchema> = {
  name: "browserbase_screenshot",
  description:
    "Takes a screenshot of the current page. Use this tool to learn where you are on the page when controlling the browser with Stagehand. Only use this tool when the other tools are not sufficient to get the information you need.",
  inputSchema: ScreenshotInputSchema,
};

async function handleScreenshot(
  context: Context,
  params: ScreenshotInput,
): Promise<ToolResult> {
  const action = async (): Promise<ToolActionResult> => {
    try {
      const page = await context.getActivePage();
      if (!page) {
        throw new Error("No active page available");
      }

      const screenshotBuffer = await page.screenshot({
        fullPage: false,
      });

      // Convert buffer to base64 string and store in memory
      const screenshotBase64 = screenshotBuffer.toString("base64");
      const name = params.name
        ? `screenshot-${params.name}-${new Date()
            .toISOString()
            .replace(/:/g, "-")}`
        : `screenshot-${new Date().toISOString().replace(/:/g, "-")}` +
          context.config.browserbaseProjectId;
      // Associate with current session id and store in memory
      const sessionId = context.currentSessionId;
      registerScreenshot(sessionId, name, screenshotBase64);

      // Notify the client that the resources changed
      const serverInstance = context.getServer();

      if (serverInstance) {
        serverInstance.notification({
          method: "notifications/resources/list_changed",
        });
      }

      return {
        content: [
          {
            type: "text",
            text: `Screenshot taken with name: ${name}`,
          },
          {
            type: "image",
            data: screenshotBase64,
            mimeType: "image/png",
          },
        ],
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to take screenshot: ${errorMsg}`);
    }
  };

  return {
    action,
    waitForNetwork: false,
  };
}

const screenshotTool: Tool<typeof ScreenshotInputSchema> = {
  capability: "core",
  schema: screenshotSchema,
  handle: handleScreenshot,
};

// ============================================================================
// Session-Based Screenshot Tool with CDP Support
// ============================================================================

const SessionScreenshotInputSchema = z.object({
  sessionId: z
    .string()
    .optional()
    .describe(
      "Session ID to capture screenshot from. If not provided, uses the current active session. " +
        "This allows capturing screenshots from specific sessions in multi-session workflows " +
        "without switching the active session context.",
    ),
  name: z
    .string()
    .optional()
    .describe(
      "Optional name for the screenshot. Used to generate a descriptive filename. " +
        "Example: 'homepage', 'checkout-page', 'product-list'",
    ),
  format: z
    .enum(["png", "jpeg"])
    .optional()
    .default("png")
    .describe(
      "Screenshot format. 'png' for lossless quality (larger files), " +
        "'jpeg' for compressed (smaller files, good for photos/complex images). " +
        "Default: 'png'",
    ),
  quality: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .default(90)
    .describe(
      "JPEG quality (0-100). Only applies when format is 'jpeg'. " +
        "Higher values = better quality but larger files. " +
        "Default: 90. Ignored for PNG format.",
    ),
  fullPage: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      "Capture the full scrollable page (true) or just the current viewport (false). " +
        "Full page screenshots may take longer for very tall pages. " +
        "Default: true",
    ),
});

type SessionScreenshotInput = z.infer<typeof SessionScreenshotInputSchema>;

/**
 * Captures a screenshot using Chrome DevTools Protocol for better performance
 * @param page The Playwright page to screenshot
 * @param options Screenshot options (format, quality, fullPage)
 * @returns Base64 encoded screenshot data
 */
async function captureScreenshotCDP(
  page: Page,
  options: {
    format?: "png" | "jpeg";
    quality?: number;
    fullPage?: boolean;
  } = {},
): Promise<string> {
  const { format = "png", quality = 90, fullPage = true } = options;

  // Get the page context and create a CDP session
  const context = page.context();
  const client: CDPSession = await context.newCDPSession(page);

  try {
    // Prepare CDP screenshot parameters
    const cdpParams: {
      format: "png" | "jpeg";
      captureBeyondViewport: boolean;
      quality?: number;
    } = {
      format,
      captureBeyondViewport: fullPage,
    };

    // Only add quality for JPEG
    if (format === "jpeg") {
      cdpParams.quality = quality;
    }

    // Capture screenshot using CDP
    const result = await client.send("Page.captureScreenshot", cdpParams);

    return result.data; // Already base64 encoded
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    throw new Error(`CDP screenshot capture failed: ${errorMsg}`);
  } finally {
    // Close CDP session to free resources
    try {
      await client.detach();
    } catch (detachError) {
      // Log but don't throw - screenshot was already captured
      process.stderr.write(
        `[tool.sessionScreenshot] Warning: Failed to detach CDP session: ${
          detachError instanceof Error
            ? detachError.message
            : String(detachError)
        }\n`,
      );
    }
  }
}

async function handleSessionScreenshot(
  context: Context,
  params: SessionScreenshotInput,
): Promise<ToolResult> {
  const action = async (): Promise<ToolActionResult> => {
    try {
      // Determine which session to use
      const targetSessionId = params.sessionId || context.currentSessionId;

      process.stderr.write(
        `[tool.sessionScreenshot] Capturing screenshot from session: ${targetSessionId}\n`,
      );

      // Get the session from SessionManager
      // Pass false to avoid creating a new session if it doesn't exist
      const session = await getSession(targetSessionId, context.config, false);

      if (!session) {
        throw new Error(
          `Session '${targetSessionId}' not found or is not active. ` +
            `Please create the session first using browserbase_session_create ` +
            `or multi_browserbase_stagehand_session_create.`,
        );
      }

      // Validate page is available and not closed
      const page = session.page;
      if (!page || page.isClosed()) {
        throw new Error(
          `Session '${targetSessionId}' has no active page or the page is closed.`,
        );
      }

      // Capture screenshot using CDP
      const screenshotBase64 = await captureScreenshotCDP(page, {
        format: params.format,
        quality: params.quality,
        fullPage: params.fullPage,
      });

      // Generate screenshot name with timestamp
      const timestamp = new Date().toISOString().replace(/:/g, "-");
      const sessionLabel = params.sessionId
        ? `session-${params.sessionId.substring(0, 8)}`
        : "current";
      const namePrefix = params.name ? `${params.name}-` : "";
      const extension = params.format === "jpeg" ? "jpg" : "png";
      const screenshotName = `screenshot-${namePrefix}${sessionLabel}-${timestamp}.${extension}`;

      // Register screenshot as MCP resource
      // Use the Browserbase session ID if available, otherwise use the internal session ID
      const resourceSessionId = session.sessionId || targetSessionId;
      registerScreenshot(resourceSessionId, screenshotName, screenshotBase64);

      process.stderr.write(
        `[tool.sessionScreenshot] Screenshot captured successfully: ${screenshotName}\n`,
      );

      // Notify the client that resources have changed
      const serverInstance = context.getServer();
      if (serverInstance) {
        serverInstance.notification({
          method: "notifications/resources/list_changed",
        });
      }

      // Determine MIME type
      const mimeType = params.format === "jpeg" ? "image/jpeg" : "image/png";

      // Calculate estimated size
      const estimatedSizeKB = Math.round(
        (screenshotBase64.length * 0.75) / 1024,
      );

      // Warn for large screenshots
      const estimatedSizeMB = estimatedSizeKB / 1024;
      if (estimatedSizeMB > 5) {
        process.stderr.write(
          `[tool.sessionScreenshot] WARNING: Large screenshot (${estimatedSizeMB.toFixed(1)}MB). ` +
            `Consider: (1) viewport-only mode, (2) JPEG format, (3) lower quality\n`,
        );
      }

      // Return success response with both text and image content
      return {
        content: [
          {
            type: "text",
            text:
              `Screenshot captured from session '${targetSessionId}'\n` +
              `Name: ${screenshotName}\n` +
              `Format: ${params.format?.toUpperCase() || "PNG"}\n` +
              `Full Page: ${params.fullPage ? "Yes" : "No (viewport only)"}\n` +
              `Size: ${estimatedSizeKB}KB (estimated)`,
          },
          {
            type: "image",
            data: screenshotBase64,
            mimeType,
          },
        ],
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `[tool.sessionScreenshot] Failed to capture screenshot: ${errorMsg}\n`,
      );
      throw new Error(`Failed to capture screenshot: ${errorMsg}`);
    }
  };

  return {
    action,
    waitForNetwork: false, // Screenshots don't need to wait for network
  };
}

const sessionScreenshotSchema: ToolSchema<typeof SessionScreenshotInputSchema> =
  {
    name: "browserbase_screenshot_session",
    description:
      "Capture a screenshot from a specific Browserbase session using Chrome DevTools Protocol for optimal performance. " +
      "This tool allows you to take screenshots from any active session without switching the current active session context. " +
      "Essential for multi-session workflows where you need to capture screenshots from multiple browsers running in parallel. " +
      "Supports both PNG (lossless, larger files) and JPEG (compressed, smaller files) formats with quality control. " +
      "Can capture full scrollable pages or just the current viewport. " +
      "If no sessionId is provided, captures from the current active session. " +
      "Use this when: (1) You have multiple sessions and want to capture from a specific one, " +
      "(2) You need format/quality control over screenshots, " +
      "(3) You want better performance than standard screenshot methods.",
    inputSchema: SessionScreenshotInputSchema,
  };

const sessionScreenshotTool: Tool<typeof SessionScreenshotInputSchema> = {
  capability: "core",
  schema: sessionScreenshotSchema,
  handle: handleSessionScreenshot,
};

// Export both tools as an array
export default [screenshotTool, sessionScreenshotTool];
