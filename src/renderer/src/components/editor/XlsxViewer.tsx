import { useEffect, useState } from 'react'
// Why: pnpm overrides pins xlsx to the SheetJS CDN tarball at 0.20.3 to avoid
// CVE-2023-30533 / CVE-2024-22363 in the 0.18.5 npm release, which npm-registry
// `^0.18.5` cannot reach.
import * as XLSX from 'xlsx'
import { translate } from '@/i18n/i18n'
import { isZipBuffer, base64ToArrayBuffer } from '@shared/zip-magic'
import styles from './OfficePreview.module.css'

export type XlsxViewerProps = {
  filePath: string
  fileName: string
  /** Base64-encoded .xlsx payload, supplied by EditorContent's file preview cache. */
  content: string
}

type SheetData = {
  name: string
  /** Sanitised, render-ready HTML for the sheet body. */
  html: string
}

type Status = { kind: 'loading' } | { kind: 'ready'; sheets: SheetData[] } | { kind: 'error' }

// ponytail: SheetJS's html output doesn't include <colgroup> widths; build one
// ourselves from ws['!cols'] so columns honour the original cell widths.
function colgroupHtml(ws: XLSX.WorkSheet): string {
  const cols = ws['!cols']
  if (!cols || cols.length === 0) {
    return ''
  }
  const cells = cols
    .map((c) => {
      const width =
        c && typeof c.wpx === 'number'
          ? c.wpx
          : c && typeof c.wch === 'number'
            ? Math.round(c.wch * 7)
            : 96
      const min = c && c.hidden ? ' display:none' : ''
      return `<col style="width:${width}px;min-width:${width}px"${min}/>`
    })
    .join('')
  return `<colgroup>${cells}</colgroup>`
}

// ponytail: SheetJS returns "<table></table>" with no rows for an empty sheet;
// detect that so we can show a localised empty state instead.
function tableHasRows(html: string): boolean {
  return /<tr[\s>]/i.test(html)
}

// Why: SheetJS's `sheet_to_html` already runs `escapehtml` on cell text, so
// the rendered HTML has no <script>/<iframe>/on*= attributes and no raw
// markup in cells. Skipping a second sanitisation pass avoids the DOMPurify
// v3 default profile (which strips <table>), and we accept the trust
// boundary: .xlsx must come from a trusted source (the editor's file-read
// path), same as how the markdown editor trusts its inputs. If a future
// SheetJS escape regression lands, add a stripper here.
function buildSheetHtml(ws: XLSX.WorkSheet): string {
  const raw = XLSX.utils.sheet_to_html(ws, { header: '', footer: '' })
  const colgroup = colgroupHtml(ws)
  const withColgroup = colgroup ? raw.replace(/^<table[^>]*>/, (m) => `${m}${colgroup}`) : raw
  // Apply header-row convention: first <tr> gets a class hook for CSS.
  return withColgroup.replace('<tr', '<tr class="firstRow"')
}

export function XlsxViewer({ filePath, fileName, content }: XlsxViewerProps): React.JSX.Element {
  const [status, setStatus] = useState<Status>({ kind: 'loading' })
  const [activeSheet, setActiveSheet] = useState<string>('')

  useEffect(() => {
    let cancelled = false
    // Why: the initial state is already {kind:'loading'}; flipping to it again
    // on every prop change forces an extra re-render before parsing completes.
    setStatus((prev) => (prev.kind === 'loading' ? prev : { kind: 'loading' }))
    ;(async () => {
      try {
        const buffer = base64ToArrayBuffer(content)
        if (!isZipBuffer(buffer)) {
          throw new Error('not a zip archive')
        }
        const wb = XLSX.read(buffer, { type: 'array' })
        const sheets: SheetData[] = wb.SheetNames.map((name) => {
          const ws = wb.Sheets[name]
          return { name, html: buildSheetHtml(ws) }
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
        {translate('auto.components.editor.XlsxViewer.l2c4d6f8a0', 'Loading {{fileName}}…', {
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

  if (status.kind === 'ready' && status.sheets.length === 0) {
    return (
      <div className={styles.officePreview}>
        {translate('auto.components.editor.XlsxViewer.e1a5c7d9f3', 'Empty sheet')}
      </div>
    )
  }

  const current = status.sheets.find((s) => s.name === activeSheet) ?? status.sheets[0]
  const isEmpty = !tableHasRows(current.html)

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
        <div className={styles.officePreview} data-testid="xlsx-empty">
          {translate('auto.components.editor.XlsxViewer.e1a5c7d9f3', 'Empty sheet')}
        </div>
      ) : (
        <div
          className={styles.officePreview}
          data-testid="xlsx-preview"
          dangerouslySetInnerHTML={{ __html: current.html }}
        />
      )}
    </div>
  )
}
