import { useEffect, useState } from 'react'
// Why: pnpm overrides pulls xlsx from the SheetJS CDN tarball (>= 0.20.3) to avoid
// CVE-2023-30533 / CVE-2024-22363 in the 0.18.5 npm release, which npm-registry
// `^0.18.5` cannot reach.
import * as XLSX from 'xlsx'
import { translate } from '@/i18n/i18n'
import CsvViewer from './CsvViewer'
import styles from './OfficePreview.module.css'

export type XlsxViewerProps = {
  filePath: string
  fileName: string
  /** Base64-encoded .xlsx payload, supplied by EditorContent's file preview cache. */
  content: string
}

type SheetData = {
  name: string
  csv: string
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

export function XlsxViewer({ filePath, fileName, content }: XlsxViewerProps): React.JSX.Element {
  const [status, setStatus] = useState<Status>({ kind: 'loading' })
  const [activeSheet, setActiveSheet] = useState<string>('')

  useEffect(() => {
    let cancelled = false
    setStatus({ kind: 'loading' })
    ;(async () => {
      try {
        const buffer = base64ToArrayBuffer(content)
        if (!isZipBuffer(buffer)) {
          throw new Error('not a zip archive')
        }
        const wb = XLSX.read(buffer, { type: 'array' })
        const sheets: SheetData[] = wb.SheetNames.map((name) => {
          const ws = wb.Sheets[name]
          // Why: delegate the actual table rendering to CsvViewer — same parser
          // would otherwise be reimplemented here with hand-rolled date formatting
          // and number column styling. The CSV form keeps one rendering path.
          return { name, csv: XLSX.utils.sheet_to_csv(ws) }
        })
        if (cancelled) {
          return
        }
        setStatus({ kind: 'ready', sheets })
        setActiveSheet(sheets[0]?.name ?? '')
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
        {translate('auto.components.editor.XlsxViewer.l2c4d6f8a0', 'Loading {fileName}…', {
          fileName
        })}
      </div>
    )
  }

  if (status.kind === 'error') {
    return (
      <div className={styles.errorBox} role="alert">
        {translate(
          'auto.components.editor.XlsxViewer.q7c1e3f5b9',
          'Unable to parse this .xlsx file — it may be corrupt or encrypted.'
        )}
      </div>
    )
  }

  const current = status.sheets.find((s) => s.name === activeSheet) ?? status.sheets[0]

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
      <CsvViewer
        key={current.name}
        content={current.csv}
        filePath={`${fileName}#${current.name}`}
      />
    </div>
  )
}
