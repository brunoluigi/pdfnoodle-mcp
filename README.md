# PDFNoodle MCP Server

A Model Context Protocol (MCP) server that enables AI assistants to generate PDFs using the [PDFNoodle](https://pdfnoodle.com) API.

## Features

- **List Templates** – Retrieve available PDF templates
- **Get Template Variables** – Inspect required variables for a template
- **Generate PDF** – Create PDFs from templates with automatic async handling
- **Check PDF Status** – Monitor long-running PDF generation requests

## Quick Start

### Prerequisites

- Node.js 20+
- PDFNoodle API key

### Install & Run

```bash
npm install
npm run dev
```

The server starts at `http://localhost:3000/mcp`

### Build for Production

```bash
npm run build
npm start
```

## Connecting MCP Clients

### Claude Desktop / Cursor

Add to your MCP config:

```json
{
  "mcpServers": {
    "pdfnoodle": {
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

### Remote Server

```json
{
  "mcpServers": {
    "pdfnoodle": {
      "url": "https://your-domain.com/mcp"
    }
  }
}
```

## Tools

### `list_templates`

Retrieve available PDF templates.

```json
{ "apiKey": "your_pdfnoodle_api_key" }
```

### `get_template_variables`

Get variables required by a template.

```json
{ "apiKey": "...", "templateId": "invoice-001" }
```

### `generate_pdf`

Generate a PDF from a template. Automatically handles long-running renders (>30s).

```json
{
  "apiKey": "...",
  "templateId": "invoice-001",
  "data": "{\"customer\": \"John Doe\", \"amount\": 100}"
}
```

### `check_pdf_status`

Check status of an async PDF generation.

```json
{ "apiKey": "...", "requestId": "pdfnoodle_request_123" }
```

## Deployment (Kamal)

```bash
kamal setup    # First time
kamal deploy   # Subsequent deploys
```

Configure `config/deploy.yml` with your server details.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `PDFNOODLE_API_BASE` | `https://api.pdfnoodle.com/v1/` | API base URL |

## License

MIT

