import express from "express";
import cors from "cors";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

// --- Configuration ---
const PORT = process.env.PORT || 3000;
const PDFNOODLE_API_BASE = process.env.PDFNOODLE_API_BASE || "https://api.pdfnoodle.com/v1/";

// Response types
interface PdfSuccessResponse {
  signedUrl: string;
  metadata?: {
    executionTime: string;
    fileSize: string;
  };
}

interface PdfQueuedResponse {
  requestId: string;
  statusUrl: string;
  message: string;
}

interface PdfStatusResponse {
  requestId: string;
  renderStatus: "ONGOING" | "SUCCESS" | "FAILED";
  signedUrl: string;
  metadata?: {
    executionTime: string;
    fileSize: string;
  };
}

// Helper for API calls
async function callApi<T = unknown>(
  apiKey: string,
  endpoint: string,
  method: "GET" | "POST",
  body?: unknown
): Promise<{ status: number; data: T }> {
  const url = `${PDFNOODLE_API_BASE}${endpoint}`;
  const headers = {
    "Authorization": `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "Accept": "application/json",
  };

  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok && response.status !== 202) {
    const errorText = await response.text();
    throw new Error(`PDFNoodle API Error (${response.status}): ${errorText}`);
  }

  const data = await response.json() as T;
  return { status: response.status, data };
}

// Poll for PDF completion with exponential backoff
async function pollForPdfCompletion(
  apiKey: string,
  requestId: string,
  maxAttempts = 20,
  initialDelayMs = 2000
): Promise<PdfStatusResponse> {
  let delay = initialDelayMs;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, delay));

    const { data } = await callApi<PdfStatusResponse>(
      apiKey,
      `pdf/status/${requestId}`,
      "GET"
    );

    if (data.renderStatus === "SUCCESS") {
      return data;
    }

    if (data.renderStatus === "FAILED") {
      throw new Error(`PDF generation failed for request ${requestId}`);
    }

    // Exponential backoff, max 10 seconds
    delay = Math.min(delay * 1.5, 10000);
  }

  throw new Error(`PDF generation timed out after ${maxAttempts} attempts for request ${requestId}`);
}

// --- MCP Server Factory (one per session) ---
function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "pdfnoodle-mcp",
    version: "1.0.0",
  });

  // Tool 1: List Templates
  server.registerTool(
    "list_templates",
    {
      title: "List Templates",
      description: "Retrieve available PDF templates from PDFNoodle",
      inputSchema: {
        apiKey: z.string().describe("Your PDFNoodle API key"),
        limit: z.number().optional().describe("Number of templates to return"),
      },
    },
    async ({ apiKey }) => {
      try {
        const { data } = await callApi(apiKey, "integration/templates", "GET");
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Error fetching templates: ${message}` }],
          isError: true,
        };
      }
    }
  );

  // Tool 2: Get Template Variables
  server.registerTool(
    "get_template_variables",
    {
      title: "Get Template Variables",
      description: "Retrieve the list of variables required by a specific PDF template",
      inputSchema: {
        apiKey: z.string().describe("Your PDFNoodle API key"),
        templateId: z.string().describe("The ID of the template to get variables for"),
      },
    },
    async ({ apiKey, templateId }) => {
      try {
        const { data } = await callApi(apiKey, `integration/templates/${templateId}/variables`, "GET");
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Error fetching template variables: ${message}` }],
          isError: true,
        };
      }
    }
  );

  // Tool 3: Check PDF Status
  server.registerTool(
    "check_pdf_status",
    {
      title: "Check PDF Status",
      description: "Check the status of an asynchronous PDF generation request",
      inputSchema: {
        apiKey: z.string().describe("Your PDFNoodle API key"),
        requestId: z.string().describe("The request ID returned from a queued PDF generation"),
      },
    },
    async ({ apiKey, requestId }) => {
      try {
        const { data } = await callApi<PdfStatusResponse>(apiKey, `pdf/status/${requestId}`, "GET");

        if (data.renderStatus === "SUCCESS") {
          return {
            content: [
              {
                type: "text",
                text: `PDF Ready! Download URL: ${data.signedUrl}\nExecution time: ${data.metadata?.executionTime || "N/A"}\nFile size: ${data.metadata?.fileSize || "N/A"}`,
              },
            ],
          };
        } else if (data.renderStatus === "ONGOING") {
          return {
            content: [
              {
                type: "text",
                text: `PDF generation is still in progress. Request ID: ${requestId}. Please check again in a few seconds.`,
              },
            ],
          };
        } else {
          return {
            content: [{ type: "text", text: `PDF generation failed. Request ID: ${requestId}` }],
            isError: true,
          };
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Error checking PDF status: ${message}` }],
          isError: true,
        };
      }
    }
  );

  // Tool 4: HTML to PDF
  server.registerTool(
    "html_to_pdf",
    {
      title: "HTML to PDF",
      description: "Convert HTML content to a PDF document. Automatically handles long-running renders by polling for completion.",
      inputSchema: {
        apiKey: z.string().describe("Your PDFNoodle API key"),
        html: z.string().describe("The HTML content you want to render"),
        pdfParams: z.string().optional().describe("JSON string of PDF parameters (e.g., page size, margins). See PDFNoodle docs for options."),
        convertToImage: z.boolean().optional().describe("If true, returns a PNG file instead of PDF (default: false)"),
        metadata: z.string().optional().describe("JSON string of PDF metadata (e.g., title, author)"),
        hasCover: z.boolean().optional().describe("If true, hides header/footer on the first page (default: false)"),
        waitForCompletion: z.boolean().optional().describe("If true (default), waits for async renders to complete. Set to false to get the requestId immediately for long renders."),
      },
    },
    async ({ apiKey, html, pdfParams, convertToImage, metadata, hasCover, waitForCompletion = true }) => {
      try {
        const payload: Record<string, unknown> = { html };

        if (pdfParams) {
          try {
            payload.pdfParams = JSON.parse(pdfParams);
          } catch {
            throw new Error("Invalid JSON provided for 'pdfParams' parameter");
          }
        }

        if (metadata) {
          try {
            payload.metadata = JSON.parse(metadata);
          } catch {
            throw new Error("Invalid JSON provided for 'metadata' parameter");
          }
        }

        if (convertToImage !== undefined) {
          payload.convertToImage = convertToImage;
        }

        if (hasCover !== undefined) {
          payload.hasCover = hasCover;
        }

        const { status, data: result } = await callApi<PdfSuccessResponse | PdfQueuedResponse>(
          apiKey,
          "html-to-pdf/sync",
          "POST",
          payload
        );

        // Immediate success (rendered in <30 seconds)
        if (status === 200) {
          const successResult = result as PdfSuccessResponse;
          const fileType = convertToImage ? "PNG" : "PDF";
          return {
            content: [
              {
                type: "text",
                text: `${fileType} Generated Successfully!\nDownload URL: ${successResult.signedUrl}\nExecution time: ${successResult.metadata?.executionTime || "N/A"}\nFile size: ${successResult.metadata?.fileSize || "N/A"}`,
              },
            ],
          };
        }

        // Queued for async processing (>30 seconds timeout)
        if (status === 202) {
          const queuedResult = result as PdfQueuedResponse;

          if (!waitForCompletion) {
            return {
              content: [
                {
                  type: "text",
                  text: `PDF generation queued (taking longer than 30 seconds).\nRequest ID: ${queuedResult.requestId}\nUse the check_pdf_status tool to monitor progress.`,
                },
              ],
            };
          }

          // Poll for completion
          const finalResult = await pollForPdfCompletion(apiKey, queuedResult.requestId);
          const fileType = convertToImage ? "PNG" : "PDF";

          return {
            content: [
              {
                type: "text",
                text: `${fileType} Generated Successfully (async)!\nDownload URL: ${finalResult.signedUrl}\nExecution time: ${finalResult.metadata?.executionTime || "N/A"}\nFile size: ${finalResult.metadata?.fileSize || "N/A"}`,
              },
            ],
          };
        }

        throw new Error(`Unexpected response status: ${status}`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Error converting HTML to PDF: ${message}` }],
          isError: true,
        };
      }
    }
  );

  // Tool 5: Generate PDF
  server.registerTool(
    "generate_pdf",
    {
      title: "Generate PDF",
      description: "Generate a PDF document using a PDFNoodle template and data. Automatically handles long-running renders by polling for completion.",
      inputSchema: {
        apiKey: z.string().describe("Your PDFNoodle API key"),
        templateId: z.string().describe("The ID of the template to use"),
        data: z.string().describe("JSON string of data variables to populate the template"),
        waitForCompletion: z.boolean().optional().describe("If true (default), waits for async renders to complete. Set to false to get the requestId immediately for long renders."),
      },
    },
    async ({ apiKey, templateId, data, waitForCompletion = true }) => {
      try {
        let parsedData;
        try {
          parsedData = JSON.parse(data);
        } catch {
          throw new Error("Invalid JSON provided for 'data' parameter");
        }

        const payload = {
          templateId,
          data: parsedData,
        };

        const { status, data: result } = await callApi<PdfSuccessResponse | PdfQueuedResponse>(
          apiKey,
          "pdf/sync",
          "POST",
          payload
        );

        // Immediate success (rendered in <30 seconds)
        if (status === 200) {
          const successResult = result as PdfSuccessResponse;
          return {
            content: [
              {
                type: "text",
                text: `PDF Generated Successfully!\nDownload URL: ${successResult.signedUrl}\nExecution time: ${successResult.metadata?.executionTime || "N/A"}\nFile size: ${successResult.metadata?.fileSize || "N/A"}`,
              },
            ],
          };
        }

        // Queued for async processing (>30 seconds timeout)
        if (status === 202) {
          const queuedResult = result as PdfQueuedResponse;

          if (!waitForCompletion) {
            return {
              content: [
                {
                  type: "text",
                  text: `PDF generation queued (taking longer than 30 seconds).\nRequest ID: ${queuedResult.requestId}\nUse the check_pdf_status tool to monitor progress.`,
                },
              ],
            };
          }

          // Poll for completion
          const finalResult = await pollForPdfCompletion(apiKey, queuedResult.requestId);

          return {
            content: [
              {
                type: "text",
                text: `PDF Generated Successfully (async)!\nDownload URL: ${finalResult.signedUrl}\nExecution time: ${finalResult.metadata?.executionTime || "N/A"}\nFile size: ${finalResult.metadata?.fileSize || "N/A"}`,
              },
            ],
          };
        }

        throw new Error(`Unexpected response status: ${status}`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Error generating PDF: ${message}` }],
          isError: true,
        };
      }
    }
  );

  return server;
}

// --- Express App with Streamable HTTP Transport ---
const app = express();
app.use(cors());
app.use(express.json());

// Session management
const transports: Record<string, StreamableHTTPServerTransport> = {};

// Health check endpoint for Kamal
app.get("/health", (_req, res) => res.send("OK"));

// MCP endpoint - handles POST, GET, DELETE
app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  let transport: StreamableHTTPServerTransport;

  if (sessionId && transports[sessionId]) {
    // Reuse existing session
    transport = transports[sessionId];
  } else if (!sessionId && isInitializeRequest(req.body)) {
    // New session initialization
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        transports[id] = transport;
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        delete transports[transport.sessionId];
      }
    };

    const server = createMcpServer();
    await server.connect(transport);
  } else {
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Invalid session" },
      id: null,
    });
    return;
  }

  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string;
  const transport = transports[sessionId];
  if (transport) {
    await transport.handleRequest(req, res);
  } else {
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Invalid session" },
      id: null,
    });
  }
});

app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string;
  const transport = transports[sessionId];
  if (transport) {
    await transport.handleRequest(req, res);
  } else {
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Invalid session" },
      id: null,
    });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 PDFNoodle MCP Server running on port ${PORT}`);
  console.log(`👉 MCP Endpoint: http://localhost:${PORT}/mcp`);
});
