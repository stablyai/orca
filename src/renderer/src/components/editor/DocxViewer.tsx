import { useEffect, useRef, useState } from 'react'
import * as mammoth from 'mammoth'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client'
import { readRuntimeFilePreview } from '@/runtime/runtime-file-client'
import styles from './OfficePreview.module.css'

export type DocxViewerProps = {
  filePath: string
  fileName: string
  runtimeContext: RuntimeFileOperationArgs
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

export function DocxViewer({
  filePath,
  fileName,
  runtimeContext
}: DocxViewerProps): React.JSX.Element {
  const [status, setStatus] = useState<Status>({ kind: 'loading' })
  // Why: callers pass an inline context object, so keying the effect on identity
  // would re-issue the preview RPC on every parent render.
  const contextKey = JSON.stringify(runtimeContext)
  const contextRef = useRef(runtimeContext)
  contextRef.current = runtimeContext

  useEffect(() => {
    let cancelled = false
    setStatus({ kind: 'loading' })
    readRuntimeFilePreview(contextRef.current, filePath)
      .then(async (preview) => {
        // Why: the preview RPC returns whitelisted binaries base64-encoded in `content`.
        const arrayBuffer = base64ToArrayBuffer(preview.content)
        // Why: mammoth's browser build reads `arrayBuffer`, its node build reads `buffer`.
        // Vite picks the browser build for the renderer; Vitest resolves the node one.
        // Its types only describe the node `Buffer` form, so narrow to the browser shape.
        const source = { arrayBuffer, buffer: arrayBuffer } as { arrayBuffer: ArrayBuffer }
        const result = await mammoth.convertToHtml(source)
        if (cancelled) {
          return
        }
        setStatus({ kind: 'ready', html: result.value || '<p>文档为空</p>' })
      })
      .catch(() => {
        if (cancelled) {
          return
        }
        setStatus({ kind: 'error' })
      })
    return () => {
      cancelled = true
    }
  }, [filePath, contextKey])

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
