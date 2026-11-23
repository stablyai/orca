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

/** Build a standalone printToPDF document with inline CSS so temp-file loading is independent of the working directory. */
export function buildMarkdownExportHtml(args: BuildMarkdownExportHtmlArgs): string {
  const title = escapeHtml(args.title || 'Untitled')
  // The export window enables JavaScript; CSP must block scripts leaked from untrusted Markdown while allowing document styles, images and fonts.
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
