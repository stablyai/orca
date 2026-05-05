import { EXPORT_CSS } from './export-css'

type BuildMarkdownExportHtmlArgs = {
  title: string
  renderedHtml: string
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Wrap a rendered markdown fragment in a standalone HTML document suitable
 * for Electron `webContents.printToPDF()`.
 *
 * The result is intentionally self-contained (inline CSS, no external links
 * except whatever the rendered fragment already references) so that loading
 * it from a temp file produces a stable paint regardless of the caller's
 * working directory.
 */
export function buildMarkdownExportHtml(args: BuildMarkdownExportHtmlArgs): string {
  const title = escapeHtml(args.title || 'Untitled')
  // Why (CSP): the generated HTML is loaded in an Electron BrowserWindow with
  // `javascript: true` (required for printToPDF layout). Without a CSP, any
  // <script> tag that leaked into the cloned rendered subtree — e.g. from a
  // malicious markdown paste or a compromised upstream renderer — would
  // execute with renderer privileges during the export. Forbidding script-src
  // entirely (no 'default-src' fallback to scripts) closes this hole while
  // still allowing inline styles (for the <style> block and element-level
  // style attributes the renderer emits), images from common schemes, and
  // data/https fonts.
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: https: http: file:; style-src 'unsafe-inline'; font-src data: https:;" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>${EXPORT_CSS}</style>
</head>
<body>
<div class="orca-export-root">
${args.renderedHtml}
</div>
</body>
</html>`
}
