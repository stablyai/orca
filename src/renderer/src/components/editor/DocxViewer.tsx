import { useEffect, useState } from 'react'
import * as mammoth from 'mammoth'
import DOMPurify from 'dompurify'
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
          html: DOMPurify.sanitize(result.value || '<p>文档为空</p>', {
            USE_PROFILES: { html: true }
          })
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
    return <div className={styles.officePreview}>正在加载 {fileName}…</div>
  }

  if (status.kind === 'error') {
    return (
      <div className={styles.errorBox} role="alert">
        无法解析此 .docx 文件, 可能已损坏或加密。
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
