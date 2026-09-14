import React, { useEffect, useRef, useState } from 'react'
import { renderAsync } from 'docx-preview'
import { translate } from '@/i18n/i18n'

type OfficeDocumentViewerProps = {
  /** DOCX blob delivered as base64 (matching FileContent.content). */
  content: string
  filePath: string
}

type RenderState = 'loading' | 'ready' | 'error'

// Why: docx-preview needs raw bytes; the renderer has no global Buffer, so
// decode base64 with atob (available in the browser and Node >= 16).
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

const ALLOWED_LINK_SCHEMES = new Set(['http', 'https', 'mailto'])

/** Absolute targets must use an allow-listed scheme; relative links pass. */
export function isSafeLinkTarget(href: string): boolean {
  // Why: browsers strip leading C0 control chars and spaces before resolving, so
  // a `\tjavascript:` link must still be treated as absolute and rejected.
  let start = 0
  while (start < href.length && href.charCodeAt(start) <= 0x20) {
    start += 1
  }
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(href.slice(start))?.[1]?.toLowerCase()
  return !scheme || ALLOWED_LINK_SCHEMES.has(scheme)
}

// Why: docx-preview assigns relationship targets to `href` verbatim, so a
// crafted document can smuggle a `javascript:`/`data:` link.
function sanitizeLinkTargets(container: HTMLElement): void {
  for (const anchor of container.querySelectorAll('a[href]')) {
    if (!isSafeLinkTarget(anchor.getAttribute('href') ?? '')) {
      anchor.removeAttribute('href')
    }
  }
}

export default function OfficeDocumentViewer({
  content,
  filePath
}: OfficeDocumentViewerProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<RenderState>('loading')

  useEffect(() => {
    let cancelled = false
    const container = containerRef.current
    if (!container) {
      return
    }
    container.innerHTML = ''
    setState('loading')
    renderAsync(base64ToBytes(content), container, container, {
      className: 'orca-docx',
      inWrapper: true,
      breakPages: true,
      ignoreLastRenderedPageBreak: true,
      // Why: altChunks render document-supplied HTML into an unsandboxed srcdoc
      // iframe — a crafted .docx could otherwise run script same-origin on open.
      renderAltChunks: false,
      // Why: keep images/fonts inline so nothing dangles as an object URL.
      useBase64URL: true
    })
      .then(() => {
        if (!cancelled) {
          // Why: docx-preview copies relationship targets into `href` verbatim,
          // so a crafted document could smuggle a `javascript:` link.
          sanitizeLinkTargets(container)
          setState('ready')
        }
      })
      .catch((error) => {
        console.error('[office-document] failed to render', error)
        if (!cancelled) {
          setState('error')
        }
      })
    return () => {
      cancelled = true
      container.innerHTML = ''
    }
  }, [content])

  return (
    <div className="relative h-full min-h-0 overflow-auto scrollbar-editor bg-muted/30">
      {state === 'loading' && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
          {translate('auto.components.editor.OfficeDocumentViewer.loading', 'Loading document…')}
        </div>
      )}
      {state === 'error' && (
        <div className="absolute inset-0 flex items-center justify-center p-6 text-sm text-muted-foreground">
          {translate(
            'auto.components.editor.OfficeDocumentViewer.readFailed',
            'The document could not be displayed.'
          )}
        </div>
      )}
      <div
        ref={containerRef}
        data-docx-path={filePath}
        className="mx-auto w-fit py-6"
        style={{ display: state === 'error' ? 'none' : undefined }}
      />
    </div>
  )
}
