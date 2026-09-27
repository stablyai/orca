import { useMemo } from 'react'
import DOMPurify from 'dompurify'
import { translate } from '@/i18n/i18n'
import { useDocumentDarkTheme } from './use-document-dark-theme'

// Why: an opaque-origin, script-free frame with a no-network CSP keeps output markup inert;
// its links aim at popups the sandbox blocks.
const OUTPUT_DOCUMENT_HEAD = `<!doctype html><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<base target="_blank">
<style>
  html, body { margin: 0; background: transparent; }
  body { padding: 4px 12px; font: 13px/1.5 system-ui, sans-serif; overflow-x: auto; }
  table { border-collapse: collapse; font-variant-numeric: tabular-nums; }
  table, th, td { border: 0; }
  th, td { padding: 4px 10px; text-align: right; border-bottom: 1px solid color-mix(in srgb, currentColor 15%, transparent); }
  thead th { border-bottom-color: color-mix(in srgb, currentColor 35%, transparent); }
  img, svg { max-width: 100%; height: auto; }
  pre, code { font-family: ui-monospace, Menlo, Consolas, monospace; }
</style>`

export function IpynbHtmlOutput({ html }: { html: string }): React.JSX.Element {
  const colorScheme = useDocumentDarkTheme() ? 'dark' : 'light'
  const srcDoc = useMemo(
    () =>
      `${OUTPUT_DOCUMENT_HEAD}<meta name="color-scheme" content="${colorScheme}">${DOMPurify.sanitize(
        html,
        {
          USE_PROFILES: { html: true, svg: true, svgFilters: true }
        }
      )}`,
    [colorScheme, html]
  )
  return (
    <iframe
      title={translate('auto.components.editor.IpynbViewer.66a3f7d330', 'Notebook HTML output')}
      // SECURITY: never add allow-same-origin or allow-scripts; notebook HTML is untrusted.
      sandbox=""
      referrerPolicy="no-referrer"
      srcDoc={srcDoc}
      // Fits a pandas head() or describe() table; larger output scrolls inside the frame.
      className="block h-72 w-full border-0"
      // Why: a color-scheme mismatch with the frame document paints an opaque canvas.
      style={{ colorScheme }}
    />
  )
}
