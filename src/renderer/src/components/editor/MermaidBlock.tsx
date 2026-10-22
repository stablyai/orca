import React, { useEffect, useId, useRef, useState } from 'react'
import { Maximize2 } from 'lucide-react'
import type mermaidNamespace from 'mermaid'
import DOMPurify from 'dompurify'
import { getMermaidConfig } from './mermaid-config'
import { readMermaidThemeColors } from './mermaid-theme-colors'
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

/** A diagram with the page background it was themed against. */
export type RenderedMermaidDiagram = { svg: string; background?: string }

type MermaidBlockProps = {
  content: string
  isDark: boolean
  htmlLabels?: boolean
  className?: string
  pendingContent?: React.ReactNode
  renderEnabled?: boolean
  onExpand?: (diagram: RenderedMermaidDiagram) => void
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
  pendingContent,
  renderEnabled = true,
  onExpand
}: MermaidBlockProps): React.JSX.Element {
  const id = useId().replace(/:/g, '_')
  const [rendered, setRendered] = useState<{
    content: string
    result: RenderedMermaidDiagram | { error: string }
  } | null>(null)
  // Why: new source waits as source, but a theme change keeps the old diagram until it re-renders.
  const result =
    pendingContent !== undefined && rendered?.content !== content
      ? null
      : (rendered?.result ?? null)

  useEffect(() => {
    if (!renderEnabled) {
      return
    }
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
        const colors = readMermaidThemeColors()
        mermaid.initialize(getMermaidConfig(isDark, htmlLabels, isDark ? colors : undefined))
        const { svg } = await mermaid.render(`mermaid-${id}`, content)
        if (!cancelled) {
          // Why: although mermaid uses DOMPurify internally, we add an explicit
          // sanitization pass as defense-in-depth against XSS in case upstream
          // behaviour changes or a mermaid version ships without sanitization.
          setRendered({
            content,
            result: {
              svg: DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true } }),
              background: colors?.background
            }
          })
        }
      } catch (err) {
        if (!cancelled) {
          setRendered({
            content,
            result: { error: err instanceof Error ? err.message : 'Invalid mermaid syntax' }
          })
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
  }, [content, htmlLabels, isDark, id, renderEnabled])

  if ((!renderEnabled || result === null) && pendingContent !== undefined) {
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
    ) : result && onExpand ? (
      <ExpandableDiagram diagram={result} onExpand={onExpand} />
    ) : (
      <div
        className="mermaid-block"
        dangerouslySetInnerHTML={result ? { __html: result.svg } : undefined}
      />
    )
  return className ? <div className={className}>{diagram}</div> : diagram
}

function ExpandableDiagram({
  diagram,
  onExpand
}: {
  diagram: RenderedMermaidDiagram
  onExpand: (diagram: RenderedMermaidDiagram) => void
}): React.JSX.Element {
  const buttonRef = useRef<HTMLButtonElement>(null)
  const label = translate('auto.components.editor.MermaidBlock.expand', 'Expand diagram')
  return (
    <div
      className="group/diagram relative cursor-zoom-in"
      onClick={() => {
        // Why: dragging across labels selects text; only a plain click expands.
        if (window.getSelection()?.isCollapsed === false) {
          return
        }
        // Why: closing the viewer returns focus to whatever was focused when it opened.
        buttonRef.current?.focus({ preventScroll: true })
        onExpand(diagram)
      }}
    >
      <div className="mermaid-block" dangerouslySetInnerHTML={{ __html: diagram.svg }} />
      <button
        ref={buttonRef}
        type="button"
        aria-label={label}
        title={label}
        onClick={(event) => {
          event.stopPropagation()
          onExpand(diagram)
        }}
        className="absolute top-0 right-0 flex size-6 items-center justify-center rounded-md bg-background/80 text-muted-foreground transition-opacity hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none can-hover:opacity-0 can-hover:group-hover/diagram:opacity-100 can-hover:focus-visible:opacity-100"
      >
        <Maximize2 className="size-3.5" />
      </button>
    </div>
  )
}
