import { useEffect, useState } from 'react'
import * as mammoth from 'mammoth'
import DOMPurify from 'dompurify'
import { translate } from '@/i18n/i18n'
import styles from './OfficePreview.module.css'

export type DocxViewerProps = {
  filePath: string
  fileName: string
  /** Base64-encoded .docx payload, supplied by EditorContent's file preview cache. */
  content: string
}

type Status = { kind: 'loading' } | { kind: 'ready'; html: string } | { kind: 'error' }

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes.buffer
}

export function DocxViewer({ filePath, fileName, content }: DocxViewerProps): React.JSX.Element {
  const [status, setStatus] = useState<Status>({ kind: 'loading' })

  useEffect(() => {
    let cancelled = false
    setStatus({ kind: 'loading' })
    ;(async () => {
      try {
        const arrayBuffer = base64ToArrayBuffer(content)
        // Why: mammoth's browser build reads `arrayBuffer`, its node build reads `buffer`.
        // Vite picks the browser build for the renderer; Vitest resolves the node one.
        // Its types only describe the node `Buffer` form, so narrow to the browser shape.
        const source = { arrayBuffer, buffer: arrayBuffer } as { arrayBuffer: ArrayBuffer }
        const result = await mammoth.convertToHtml(source)
        if (cancelled) {
          return
        }
        setStatus({
          kind: 'ready',
          html: DOMPurify.sanitize(
            result.value ||
              `<p>${translate('auto.components.editor.DocxViewer.m4e7f2a1c8', 'Empty document')}</p>`,
            {
              USE_PROFILES: { html: true }
            }
          )
        })
      } catch {
        if (cancelled) {
          return
        }
        setStatus({ kind: 'error' })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [filePath, content])

  if (status.kind === 'loading') {
    return (
      <div className={styles.officePreview}>
        {translate('auto.components.editor.DocxViewer.k1a3b5c7d9', 'Loading {fileName}…', {
          fileName
        })}
      </div>
    )
  }

  if (status.kind === 'error') {
    return (
      <div className={styles.errorBox} role="alert">
        {translate(
          'auto.components.editor.DocxViewer.p6b9d3e5f1',
          'Unable to parse this .docx file — it may be corrupt or encrypted.'
        )}
      </div>
    )
  }

  return (
    <div
      className={styles.officePreview}
      data-testid="docx-preview"
      dangerouslySetInnerHTML={{ __html: status.html }}
    />
  )
}
