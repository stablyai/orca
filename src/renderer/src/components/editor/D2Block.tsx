import React, { useEffect, useState } from 'react'
import DOMPurify from 'dompurify'
import type { D2RenderResult } from '../../../../shared/d2-render-types'
import { translate } from '@/i18n/i18n'

// Why: each render spawns a d2 process in main. Serializing caps that load and lets a block
// whose source changed while queued skip its stale render. Collapsing the chain keeps old
// closures collectable (same pattern as MermaidBlock).
let renderQueue: Promise<void> = Promise.resolve()

function enqueueRender(fn: () => Promise<void>): void {
  const tail = renderQueue.then(fn, fn).then(() => {
    if (renderQueue === tail) {
      renderQueue = Promise.resolve()
    }
  })
  renderQueue = tail
}

/**
 * Renders a d2 diagram with the user's local d2 CLI. Falls back to the raw source with a
 * hint or error line — never breaks the rest of the preview.
 */
export default function D2Block({
  content,
  isDark,
  showSource = true
}: {
  content: string
  isDark: boolean
  // Why: the rich editor already shows the editable source right above.
  showSource?: boolean
}): React.JSX.Element | null {
  const [result, setResult] = useState<D2RenderResult | null>(null)

  useEffect(() => {
    let cancelled = false
    enqueueRender(async () => {
      if (cancelled) {
        return
      }
      let next: D2RenderResult
      try {
        next = await window.api.d2.render({ source: content, isDark })
      } catch (err) {
        next = { ok: false, reason: 'error', message: err instanceof Error ? err.message : '' }
      }
      if (!cancelled) {
        setResult(
          next.ok
            ? {
                ok: true,
                // Why: d2 shadows need the filter primitives that only the svgFilters profile keeps.
                svg: DOMPurify.sanitize(next.svg, { USE_PROFILES: { svg: true, svgFilters: true } })
              }
            : next
        )
      }
    })
    return () => {
      cancelled = true
    }
  }, [content, isDark])

  if (result?.ok) {
    return <div className="d2-block" dangerouslySetInnerHTML={{ __html: result.svg }} />
  }
  const notice =
    result?.reason === 'error' ? (
      <div className="d2-error">
        {translate('auto.components.editor.D2Block.diagramError', 'Diagram error:')}{' '}
        {result.message}
      </div>
    ) : result?.reason === 'missing' ? (
      <div className="d2-hint">
        {translate(
          'auto.components.editor.D2Block.installHint',
          'Install the d2 CLI to render this diagram.'
        )}
      </div>
    ) : null
  if (!notice && !showSource) {
    return null
  }
  return (
    <div className="d2-block">
      {notice}
      {showSource && (
        <pre>
          <code>{content}</code>
        </pre>
      )}
    </div>
  )
}
