import React, { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Maximize2, Minus, Plus, RotateCcw } from 'lucide-react'
import mermaid from 'mermaid'
import DOMPurify from 'dompurify'
import { Button } from '@/components/ui/button'
import { getMermaidConfig } from './mermaid-config'
import {
  continuousMermaidZoom,
  fitMermaidZoom,
  getMermaidSvgBaseSize,
  MERMAID_ZOOM_MAX,
  MERMAID_ZOOM_MIN,
  nudgeMermaidZoom
} from './mermaid-zoom'

type MermaidBlockProps = {
  content: string
  isDark: boolean
  htmlLabels?: boolean
}

type Translate = { x: number; y: number }

const INITIAL_TRANSLATE: Translate = { x: 0, y: 0 }

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
  htmlLabels = true
}: MermaidBlockProps): React.JSX.Element {
  const id = useId().replace(/:/g, '_')
  const viewportRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [zoom, setZoom] = useState(1)
  const [translate, setTranslate] = useState<Translate>(INITIAL_TRANSLATE)
  const [isPanning, setIsPanning] = useState(false)
  const zoomRef = useRef(1)
  const translateRef = useRef<Translate>(INITIAL_TRANSLATE)

  const computeFitZoom = useCallback((): number => {
    const viewport = viewportRef.current
    const svg = containerRef.current?.querySelector('svg')
    if (!viewport || !(svg instanceof SVGSVGElement)) {
      return 1
    }

    const baseSize = getMermaidSvgBaseSize({
      width: svg.getAttribute('width'),
      height: svg.getAttribute('height'),
      viewBox: svg.getAttribute('viewBox')
    })
    if (!baseSize) {
      return 1
    }

    const rect = viewport.getBoundingClientRect()
    return fitMermaidZoom({
      svgWidth: baseSize.width,
      svgHeight: baseSize.height,
      viewportWidth: rect.width,
      viewportHeight: rect.height
    })
  }, [])

  const resetView = useCallback(() => {
    setZoom(computeFitZoom())
    setTranslate(INITIAL_TRANSLATE)
  }, [computeFitZoom])

  useEffect(() => {
    setZoom(1)
    setTranslate(INITIAL_TRANSLATE)
  }, [content])

  useEffect(() => {
    zoomRef.current = zoom
    translateRef.current = translate
    applyMermaidTransform(containerRef.current, zoom, translate)
  }, [zoom, translate])

  useEffect(() => {
    let cancelled = false

    const render = async (): Promise<void> => {
      try {
        // Why: Mermaid stores initialize() config in global module state. Apply
        // the config inside the same serialized render task so another
        // MermaidBlock cannot overwrite htmlLabels/theme between initialize()
        // and render(), which would make markdown preview fall back to the
        // broken foreignObject label path again.
        mermaid.initialize(getMermaidConfig(isDark, htmlLabels))
        const { svg } = await mermaid.render(`mermaid-${id}`, content)
        if (!cancelled && containerRef.current) {
          // Why: although mermaid uses DOMPurify internally, we add an explicit
          // sanitization pass as defense-in-depth against XSS in case upstream
          // behaviour changes or a mermaid version ships without sanitization.
          containerRef.current.innerHTML = DOMPurify.sanitize(svg, {
            USE_PROFILES: { svg: true }
          })
          applyMermaidTransform(
            containerRef.current,
            zoomRef.current,
            translateRef.current
          )
          setError(null)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Invalid mermaid syntax')
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
  }, [content, htmlLabels, isDark, id])

  const zoomPercent = Math.round(zoom * 100)

  const handleWheel = (event: React.WheelEvent<HTMLDivElement>): void => {
    if (!event.ctrlKey && !event.metaKey && !event.altKey) {
      return
    }

    event.preventDefault()
    setZoom((current) => continuousMermaidZoom(current, event.deltaY))
  }

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) {
      return
    }
    const target = event.target as HTMLElement
    if (target.closest('button, a, input')) {
      return
    }
    setIsPanning(true)
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!isPanning) {
      return
    }
    setTranslate((current) => ({
      x: current.x + event.movementX,
      y: current.y + event.movementY
    }))
  }

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    setIsPanning(false)
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.target !== event.currentTarget) {
      return
    }
    if (event.key === '+' || event.key === '=') {
      event.preventDefault()
      setZoom((current) => nudgeMermaidZoom(current, 1))
    } else if (event.key === '-' || event.key === '_') {
      event.preventDefault()
      setZoom((current) => nudgeMermaidZoom(current, -1))
    } else if (event.key === '0' || event.key === 'r') {
      event.preventDefault()
      resetView()
    }
  }

  const handleDoubleClick = (): void => {
    resetView()
  }

  if (error) {
    return (
      <div className="mermaid-block">
        <div className="mermaid-error">Diagram error: {error}</div>
        <pre>
          <code>{content}</code>
        </pre>
      </div>
    )
  }

  return (
    <div className="mermaid-block">
      <div className="mermaid-toolbar">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="mermaid-toolbar-button"
          onClick={() => setZoom((current) => nudgeMermaidZoom(current, -1))}
          disabled={zoom <= MERMAID_ZOOM_MIN}
          aria-label="Zoom out diagram"
          title="Zoom out (-)"
        >
          <Minus />
        </Button>
        <span className="mermaid-toolbar-zoom">{zoomPercent}%</span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="mermaid-toolbar-button"
          onClick={resetView}
          aria-label="Fit diagram to viewport"
          title="Fit to viewport (0 or R)"
        >
          <Maximize2 />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="mermaid-toolbar-button"
          onClick={() => {
            setZoom(1)
            setTranslate(INITIAL_TRANSLATE)
          }}
          disabled={zoom === 1 && translate.x === 0 && translate.y === 0}
          aria-label="Reset diagram zoom to 100%"
          title="Reset to 100%"
        >
          <RotateCcw />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="mermaid-toolbar-button"
          onClick={() => setZoom((current) => nudgeMermaidZoom(current, 1))}
          disabled={zoom >= MERMAID_ZOOM_MAX}
          aria-label="Zoom in diagram"
          title="Zoom in (+)"
        >
          <Plus />
        </Button>
      </div>
      <div
        ref={viewportRef}
        className="mermaid-viewport"
        data-panning={isPanning || undefined}
        tabIndex={0}
        role="group"
        aria-label="Mermaid diagram viewport. Use plus and minus to zoom, zero or R to fit."
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onDoubleClick={handleDoubleClick}
        onKeyDown={handleKeyDown}
      >
        <div className="mermaid-canvas">
          <div ref={containerRef} />
        </div>
      </div>
    </div>
  )
}

function applyMermaidTransform(
  container: HTMLDivElement | null,
  zoom: number,
  translate: Translate
): void {
  const svg = container?.querySelector('svg')
  if (!(svg instanceof SVGSVGElement)) {
    return
  }

  const baseSize = getMermaidSvgBaseSize({
    width: svg.getAttribute('width'),
    height: svg.getAttribute('height'),
    viewBox: svg.getAttribute('viewBox')
  })

  // Why: Mermaid often emits a fixed-width SVG plus max-width: 100%.
  // Scaling the wrapper alone leaves those diagrams at their intrinsic size, so
  // we size the SVG itself and disable the responsive max-width clamp.
  svg.style.maxWidth = 'none'
  svg.style.width = baseSize ? `${baseSize.width * zoom}px` : `${zoom * 100}%`
  svg.style.height = baseSize?.height ? `${baseSize.height * zoom}px` : 'auto'
  svg.style.transform = `translate(${translate.x}px, ${translate.y}px)`
  svg.style.transformOrigin = '0 0'
}
