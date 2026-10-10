import React, { useEffect, useId, useState } from 'react'
import type mermaidNamespace from 'mermaid'
import DOMPurify from 'dompurify'
import { getMermaidConfig } from './mermaid-config'
import { translate } from '@/i18n/i18n'

type MermaidApi = typeof mermaidNamespace

// Why: mermaid is ~650KB and only needed when a diagram actually renders, yet a
// static import drags it into the eager startup chunk (it is reachable from the
// sidebar comment-markdown path). Load it on first render and cache the promise
// so subsequent diagrams reuse the same module instance.
let mermaidModulePromise: Promise<MermaidApi> | null = null
function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidModulePromise) {
    mermaidModulePromise = import('mermaid').then((mod) => mod.default)
  }
  return mermaidModulePromise
}

type MermaidBlockProps = {
  content: string
  isDark: boolean
  htmlLabels?: boolean
  className?: string
  pendingContent?: React.ReactNode
}

// Why: mermaid.render() manipulates global DOM state (element IDs, internal
// parser state). Running multiple renders concurrently causes race conditions
// where one render can clobber another's temporary DOM node. Serializing all
// render calls through a single promise chain avoids this.
//
// The queue is replaced with a fresh promise once all waiting renders complete so
// that old .then() closures (which capture content and id)
// become unreachable and can be GC'd. Without this, the chain grows with
// every MermaidBlock mount/unmount cycle for the lifetime of the renderer.
let renderQueue: Promise<void> = Promise.resolve()

function enqueueRender(fn: () => Promise<void>): void {
  const tail = renderQueue.then(fn, fn).then(() => {
    // Why: collapse the chain back to a single resolved promise so previous
    // closures do not remain reachable through a growing .then() chain.
    if (renderQueue === tail) {
      renderQueue = Promise.resolve()
    }
  })
  renderQueue = tail
}

/**
 * Renders a mermaid diagram string as SVG. Falls back to raw source with an
 * error banner if the syntax is invalid — never breaks the rest of the preview.
 */
export default function MermaidBlock({
  content,
  isDark,
  htmlLabels = false,
  className,
  pendingContent
}: MermaidBlockProps): React.JSX.Element {
  const id = useId().replace(/:/g, '_')
  const [result, setResult] = useState<{ svg: string } | { error: string } | null>(null)

  useEffect(() => {
    let cancelled = false

    const render = async (): Promise<void> => {
      try {
        const mermaid = await loadMermaid()
        if (cancelled) {
          return
        }
        // Why: Mermaid stores initialize() config in global module state. Apply
        // the config inside the same serialized render task so another
        // MermaidBlock cannot overwrite htmlLabels/theme between initialize()
        // and render(), which would make markdown preview fall back to the
        // broken foreignObject label path again.
        mermaid.initialize(getMermaidConfig(isDark, htmlLabels))
        const { svg } = await mermaid.render(`mermaid-${id}`, content)
        if (!cancelled) {
          // Why: although mermaid uses DOMPurify internally, we add an explicit
          // sanitization pass as defense-in-depth against XSS in case upstream
          // behaviour changes or a mermaid version ships without sanitization.
          setResult({
            svg: DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true } })
          })
        }
      } catch (err) {
        if (!cancelled) {
          setResult({ error: err instanceof Error ? err.message : 'Invalid mermaid syntax' })
          // Mermaid leaves an error element in the DOM on failure — clean it up.
          const errorEl = document.getElementById(`d${`mermaid-${id}`}`)
          errorEl?.remove()
        }
      }
    }

    // Serialize render calls through a module-level queue to avoid race
    // conditions from concurrent mermaid.render() invocations.
    enqueueRender(render)
    return () => {
      cancelled = true
    }
  }, [content, htmlLabels, isDark, id])

  if (result === null && pendingContent !== undefined) {
    return <>{pendingContent}</>
  }

  const diagram =
    result && 'error' in result ? (
      <div className="mermaid-block">
        <div className="mermaid-error">
          {translate('auto.components.editor.MermaidBlock.dcc132e691', 'Diagram error:')}{' '}
          {result.error}
        </div>
        <pre>
          <code>{content}</code>
        </pre>
      </div>
    ) : (
      <div
        className="mermaid-block"
        dangerouslySetInnerHTML={result ? { __html: result.svg } : undefined}
      />
    )
  return className ? <div className={className}>{diagram}</div> : diagram
}
