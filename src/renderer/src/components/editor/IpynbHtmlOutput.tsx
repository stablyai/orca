import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import DOMPurify from 'dompurify'
import { translate } from '@/i18n/i18n'
import { resolveDocumentTheme } from '@/lib/document-theme'
import { useAppStore } from '@/store'

function outputDocumentPrefix(colorScheme: 'light' | 'dark'): string {
  return `<!doctype html>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<style>
  :root { color-scheme: ${colorScheme}; }
  html, body { margin: 0; padding: 0; background: transparent; color: CanvasText; }
  body { padding: 12px; font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  table { border-collapse: collapse; max-width: 100%; }
  th, td { border: 1px solid color-mix(in srgb, currentColor 20%, transparent); padding: 4px 8px; text-align: left; }
  img, svg { max-width: 100%; height: auto; }
  pre { overflow: auto; white-space: pre-wrap; }
</style>`
}

const MIN_HEIGHT_PX = 72
const MAX_HEIGHT_PX = 960

function sanitizeOutputHtml(value: string): string {
  const sanitized = DOMPurify.sanitize(value, {
    USE_PROFILES: { html: true, svg: true, svgFilters: true },
    FORBID_TAGS: ['button', 'form', 'input', 'select', 'textarea'],
    FORBID_ATTR: ['autofocus', 'formaction']
  })
  const parsed = new DOMParser().parseFromString(sanitized, 'text/html')
  // Defense-in-depth: DOMPurify already strips handlers, drop any survivors.
  for (const element of parsed.querySelectorAll('*')) {
    for (const attr of Array.from(element.attributes)) {
      if (attr.name.toLowerCase().startsWith('on')) {
        element.removeAttribute(attr.name)
      }
    }
  }
  for (const element of parsed.querySelectorAll('[href], [xlink\\:href]')) {
    const href = element.getAttribute('href') ?? element.getAttribute('xlink:href') ?? ''
    // Keep in-output fragment links only; block javascript:/external navigation.
    if (!href.trim().startsWith('#')) {
      element.removeAttribute('href')
      element.removeAttribute('xlink:href')
    }
  }
  return parsed.body.innerHTML
}

export function IpynbHtmlOutput({ value }: { value: string }): React.JSX.Element {
  const settings = useAppStore((state) => state.settings)
  const colorScheme = resolveDocumentTheme(settings?.theme ?? 'system') ? 'dark' : 'light'
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(MIN_HEIGHT_PX)
  const [loadVersion, setLoadVersion] = useState(0)
  const srcDoc = useMemo(
    () => `${outputDocumentPrefix(colorScheme)}${sanitizeOutputHtml(value)}`,
    [colorScheme, value]
  )
  const resizeToContent = useCallback((): void => {
    const body = frameRef.current?.contentDocument?.body
    if (!body) {
      return
    }
    const contentHeight = Math.ceil(body.getBoundingClientRect().height)
    setHeight(Math.min(MAX_HEIGHT_PX, Math.max(MIN_HEIGHT_PX, contentHeight + 2)))
  }, [])
  useEffect(() => {
    if (loadVersion === 0) {
      return
    }
    resizeToContent()
    const frameDocument = frameRef.current?.contentDocument
    if (!frameDocument || typeof ResizeObserver === 'undefined') {
      return
    }
    const observer = new ResizeObserver(resizeToContent)
    observer.observe(frameDocument.body)
    return () => observer.disconnect()
  }, [srcDoc, loadVersion, resizeToContent])

  // allow-same-origin enables size measurement via contentDocument; no
  // allow-scripts, so output stays inert under CSP default-src 'none'.
  return (
    <iframe
      ref={frameRef}
      title={translate('auto.components.editor.IpynbViewer.66a3f7d330', 'Notebook HTML output')}
      sandbox="allow-same-origin"
      referrerPolicy="no-referrer"
      loading="lazy"
      className="block w-full border-0 bg-background"
      style={{ height }}
      srcDoc={srcDoc}
      onLoad={() => setLoadVersion((current) => current + 1)}
    />
  )
}
