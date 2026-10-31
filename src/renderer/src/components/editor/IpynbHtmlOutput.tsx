// @protected-copy: notebook trust and kernel setup copy.
import { useMemo } from 'react'
import DOMPurify from 'dompurify'
import { useTranslation } from 'react-i18next'
import { translate } from '@/i18n/i18n'
import { useDocumentDarkTheme } from '@/hooks/use-document-dark-theme'

// Keep untrusted markup inert with an opaque-origin, script-free frame and no-network CSP; sandboxing blocks link popups.
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
  // Why: memoized cell outputs skip parent re-renders, so subscribe to language changes here.
  useTranslation()
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
      className="block h-72 w-full border-0"
      // Why: a color-scheme mismatch with the frame document paints an opaque canvas.
      style={{ colorScheme }}
    />
  )
}
