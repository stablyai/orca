import { useEffect, useRef, useState } from 'react'
import * as XLSX from 'xlsx'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client'
import { readRuntimeFilePreview } from '@/runtime/runtime-file-client'
import styles from './OfficePreview.module.css'

export type XlsxViewerProps = {
  filePath: string
  fileName: string
  runtimeContext: RuntimeFileOperationArgs
}

type SheetData = {
  name: string
  rows: (string | number | null)[][]
}

type Status = { kind: 'loading' } | { kind: 'ready'; sheets: SheetData[] } | { kind: 'error' }

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes.buffer
}

// Why: xlsx files are ZIP archives; .xlsx.read is lenient and happily
// produces a single empty "Sheet1" on a non-ZIP buffer, so we check the
// archive signature ourselves before parsing.
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]

function isZipBuffer(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 4) {
    return false
  }
  const head = new Uint8Array(buffer, 0, 4)
  return (
    head[0] === ZIP_MAGIC[0] &&
    head[1] === ZIP_MAGIC[1] &&
    head[2] === ZIP_MAGIC[2] &&
    head[3] === ZIP_MAGIC[3]
  )
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) {
    return ''
  }
  if (value instanceof Date) {
    const yyyy = value.getFullYear()
    const mm = String(value.getMonth() + 1).padStart(2, '0')
    const dd = String(value.getDate()).padStart(2, '0')
    return `${yyyy}-${mm}-${dd}`
  }
  return String(value)
}

export function XlsxViewer({
  filePath,
  fileName,
  runtimeContext
}: XlsxViewerProps): React.JSX.Element {
  const [status, setStatus] = useState<Status>({ kind: 'loading' })
  const [activeSheet, setActiveSheet] = useState<string>('')
  // Why: callers pass an inline context object, so keying the effect on identity
  // would re-issue the preview RPC on every parent render.
  const contextKey = JSON.stringify(runtimeContext)
  const contextRef = useRef(runtimeContext)
  contextRef.current = runtimeContext

  useEffect(() => {
    let cancelled = false
    setStatus({ kind: 'loading' })
    readRuntimeFilePreview(contextRef.current, filePath)
      .then((preview) => {
        // Why: the preview RPC returns whitelisted binaries base64-encoded in `content`.
        const buffer = base64ToArrayBuffer(preview.content)
        if (!isZipBuffer(buffer)) {
          throw new Error('not a zip archive')
        }
        const wb = XLSX.read(buffer, { type: 'array', cellDates: true })
        const sheets: SheetData[] = wb.SheetNames.map((name) => {
          const ws = wb.Sheets[name]
          const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, {
            header: 1,
            raw: false,
            defval: ''
          }) as (string | number | null)[][]
          return { name, rows }
        })
        if (cancelled) {
          return
        }
        setStatus({ kind: 'ready', sheets })
        setActiveSheet(sheets[0]?.name ?? '')
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
        无法解析此 .xlsx 文件, 可能已损坏或加密。
      </div>
    )
  }

  if (status.sheets.length === 0) {
    return <div className={styles.emptyMsg}>空工作簿</div>
  }

  const current = status.sheets.find((s) => s.name === activeSheet)
  const isEmpty = current && current.rows.length === 0

  return (
    <div>
      <div className={styles.sheetTabs} role="tablist">
        {status.sheets.map((s) => (
          <button
            key={s.name}
            role="tab"
            aria-selected={s.name === activeSheet}
            data-active={s.name === activeSheet}
            className={styles.sheetTab}
            onClick={() => setActiveSheet(s.name)}
          >
            {s.name}
          </button>
        ))}
      </div>
      {isEmpty ? (
        <div className={styles.emptyMsg}>空 sheet</div>
      ) : (
        <div className={styles.officePreview}>
          <table>
            <tbody>
              {current?.rows.map((row, ri) => (
                <tr key={ri}>
                  {row.map((cell, ci) => (
                    <td
                      key={ci}
                      className={typeof cell === 'number' ? styles.cellNumber : undefined}
                    >
                      {formatCell(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
