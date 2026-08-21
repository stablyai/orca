import { useEffect, useState } from 'react'
import * as mammoth from 'mammoth'
import DOMPurify from 'dompurify'
import { translate } from '@/i18n/i18n'
import { officeDocumentStyleMap } from './office-document-style-map'
import styles from './OfficePreview.module.css'

export type DocxViewerProps = {
  filePath: string
  fileName: string
  /** Base64-encoded .docx payload, supplied by EditorContent's file preview cache. */
  content: string
}

type Status = { kind: 'loading' } | { kind: 'ready'; html: string } | { kind: 'error' }

// ponytail: mammoth's default style map ignores paragraph alignment (a
// direct-format property). We re-tag aligned paragraphs with a synthetic
// styleId so the styleMap can route them to a wrapper element with the
// matching text-align.
function alignTransform(element: unknown): unknown {
  if (!element || typeof element !== 'object') {
    return element
  }
  const node = element as { type?: string; children?: unknown[]; alignment?: string; styleId?: string }
  if (node.children) {
    node.children = node.children.map(alignTransform)
  }
  if (node.type === 'paragraph' && node.alignment && node.alignment !== 'left') {
    const idMap: Record<string, string> = {
      center: 'AlgnCenter',
      right: 'AlgnRight',
      both: 'AlgnJustify',
      justify: 'AlgnJustify'
    }
    const styleId = idMap[node.alignment]
    if (styleId) {
      // Why: only set styleId — preserve the paragraph's original styleName so
      // mammoth rules like `p[style-name='Quote']` still match when the user
      // also centered the Quote. The styleMap also has `p.AlgnCenter => ...`
      // keyed on styleId for the alignment-only case.
      return { ...node, styleId }
    }
  }
  return node
}

// ponytail: DOMPurify v3's `USE_PROFILES: { html: true }` profile omits h1-h6/u/s;
// whitelist the tags mammoth actually emits so headings and inline formatting
// survive sanitization instead of flattening to text.
const DOCX_ALLOWED_TAGS = [
  'a',
  'b',
  'blockquote',
  'br',
  'div',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'i',
  'li',
  'ol',
  'p',
  's',
  'span',
  'strong',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
  'u',
  'ul'
]
const DOCX_ALLOWED_ATTR = ['href', 'id', 'class', 'rel', 'target', 'title']

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
        const result = await mammoth.convertToHtml(source, {
          includeDefaultStyleMap: true,
          styleMap: officeDocumentStyleMap,
          transformDocument: alignTransform as (element: unknown) => unknown
        })
        if (cancelled) {
          return
        }
        setStatus({
          kind: 'ready',
          html: DOMPurify.sanitize(
            result.value ||
              `<p>${translate('auto.components.editor.DocxViewer.m4e7f2a1c8', 'Empty document')}</p>`,
            {
              ALLOWED_TAGS: DOCX_ALLOWED_TAGS,
              ALLOWED_ATTR: DOCX_ALLOWED_ATTR
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
        {translate('auto.components.editor.DocxViewer.k1a3b5c7d9', 'Loading {{fileName}}…', {
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
