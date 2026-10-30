import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { Maximize2 } from 'lucide-react'
import type mermaidNamespace from 'mermaid'
import DOMPurify from 'dompurify'
import { readableMermaidFlowchartSvg } from '../../../../shared/mermaid-flowchart-contrast'
import { getMermaidConfig } from './mermaid-config'
import { readMermaidThemeColors } from './mermaid-theme-colors'
import { translate } from '@/i18n/i18n'

type MermaidApi = typeof mermaidNamespace

// Load Mermaid on demand to keep its large bundle out of the eager sidebar markdown path; reuse one module promise.
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
  onRenderComplete?: () => void
  onExpand?: (diagram: RenderedMermaidDiagram) => void
}

// Serialize Mermaid’s global DOM/parser state; reset the settled queue so old content and ID closures become unreachable.
let renderQueue: Promise<void> = Promise.resolve()

function enqueueRender(fn: () => Promise<void>): void {
  const tail = renderQueue.then(fn, fn).then(() => {
    // Release settled render closures instead of retaining a growing promise chain.
    if (renderQueue === tail) {
      renderQueue = Promise.resolve()
    }
  })
  renderQueue = tail
}

/** Render SVG with a source/error fallback so invalid syntax cannot break the preview. */
export default function MermaidBlock({
  content,
  isDark,
  htmlLabels = false,
  className,
  pendingContent,
  renderEnabled = true,
  onRenderComplete,
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
        // Initialize inside the serialized task because global Mermaid config can otherwise change between initialization and render.
        const colors = readMermaidThemeColors()
        mermaid.initialize(getMermaidConfig(isDark, htmlLabels, isDark ? colors : undefined))
        const { svg } = await mermaid.render(`mermaid-${id}`, content)
        if (!cancelled) {
          // Sanitize explicitly against XSS even if Mermaid’s internal sanitization changes.
          const sanitized = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true } })
          setRendered({
            content,
            result: {
              svg: colors
                ? readableMermaidFlowchartSvg(sanitized, colors.foreground, colors.background)
                : sanitized,
              background: colors?.background
            }
          })
        }
      } catch (err) {
        if (!cancelled) {
          setRendered({
            content,
            result: {
              error:
                err instanceof Error
                  ? err.message
                  : translate(
                      'auto.components.editor.MermaidBlock.invalidSyntax',
                      'Invalid mermaid syntax'
                    )
            }
          })
          // Mermaid leaves an error element in the DOM on failure — clean it up.
          const errorEl = document.getElementById(`d${`mermaid-${id}`}`)
          errorEl?.remove()
        }
      }
    }

    enqueueRender(render)
    return () => {
      cancelled = true
    }
  }, [content, htmlLabels, isDark, id, renderEnabled])

  useLayoutEffect(() => {
    if (renderEnabled && rendered?.content === content) {
      onRenderComplete?.()
    }
  }, [content, rendered, renderEnabled, onRenderComplete])

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
