import React, { useCallback, useEffect, useId, useRef, useState } from 'react'
import type mermaidNamespace from 'mermaid'
import DOMPurify from 'dompurify'
import { getMermaidConfig } from './mermaid-config'
import MermaidDiagramLightbox from './MermaidDiagramLightbox'
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
}

// Why: mermaid.render() manipulates global DOM state (element IDs, internal
// parser state). Running multiple renders concurrently causes race conditions
// where one render can clobber another's temporary DOM node. Serializing all
// render calls through a single promise chain avoids this.
//
// The queue is replaced with a fresh promise after each render completes so
// that old .then() closures (which capture containerRef, content, and id)
// become unreachable and can be GC'd. Without this, the chain grows with
// every MermaidBlock mount/unmount cycle for the lifetime of the renderer.
let renderQueue: Promise<void> = Promise.resolve()

function enqueueRender(fn: () => Promise<void>): void {
  renderQueue = renderQueue.then(fn, fn).then(() => {
    // Why: collapse the chain back to a single resolved promise so previous
    // closures do not remain reachable through a growing .then() chain.
    renderQueue = Promise.resolve()
  })
}

/**
 * Renders a mermaid diagram string as SVG. Falls back to raw source with an
 * error banner if the syntax is invalid — never breaks the rest of the preview.
 */
export default function MermaidBlock({
  content,
  isDark,
  htmlLabels = false
}: MermaidBlockProps): React.JSX.Element {
  const id = useId().replace(/:/g, '_')
  const renderId = `mermaid-${id}`
  const containerRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [renderedKey, setRenderedKey] = useState<string | null>(null)
  const renderKey = `${isDark}|${htmlLabels}|${content}`
  // Why: while a new render waits in the queue, the inline SVG still shows the
  // previous diagram; hide the expand control instead of opening stale output.
  const isRenderCurrent = renderedKey === renderKey

  const getExpandedSvgMarkup = useCallback((): string | null => {
    const markup = containerRef.current?.innerHTML
    // Why: the expanded copy lives in the same document; its scoped <style>
    // and marker url(#…) refs must not collide with the inline diagram's IDs.
    return markup ? markup.replaceAll(renderId, `${renderId}-expanded`) : null
  }, [renderId])

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
        const { svg } = await mermaid.render(renderId, content)
        if (!cancelled && containerRef.current) {
          // Why: although mermaid uses DOMPurify internally, we add an explicit
          // sanitization pass as defense-in-depth against XSS in case upstream
          // behaviour changes or a mermaid version ships without sanitization.
          containerRef.current.innerHTML = DOMPurify.sanitize(svg, {
            USE_PROFILES: { svg: true }
          })
          setRenderedKey(renderKey)
          setError(null)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Invalid mermaid syntax')
          setRenderedKey(null)
          // Mermaid leaves an error element in the DOM on failure — clean it up.
          const errorEl = document.getElementById(`d${renderId}`)
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
  }, [content, htmlLabels, isDark, renderId, renderKey])

  if (error) {
    return (
      <div className="mermaid-block">
        <div className="mermaid-error">
          {translate('auto.components.editor.MermaidBlock.dcc132e691', 'Diagram error:')} {error}
        </div>
        <pre>
          <code>{content}</code>
        </pre>
      </div>
    )
  }

  return (
    <div className="mermaid-block group/mermaid relative">
      <div ref={containerRef} />
      {isRenderCurrent && <MermaidDiagramLightbox getSvgMarkup={getExpandedSvgMarkup} />}
    </div>
  )
}
