import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Maximize2, Minus, Plus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { createConversationKnowledgeMapOverviewLayout } from '@/lib/conversation-knowledge-map-layout'
import {
  buildConversationKnowledgeMap,
  type ConversationKnowledgeMapConcept
} from '@/lib/conversation-knowledge-map'
import type {
  ConversationKnowledgeGraph,
  ConversationKnowledgeGraphNode
} from '../../../shared/conversation-knowledge-graph'

type Viewport = { height: number; width: number }
type Transform = { scale: number; x: number; y: number }

const MIN_SCALE = 0.2
const MAX_SCALE = 2

export function ConversationKnowledgeMap({
  graph,
  selectedConceptId,
  onSelectConcept
}: {
  graph: ConversationKnowledgeGraph
  selectedConceptId: string | null
  onSelectConcept: (concept: ConversationKnowledgeGraphNode) => void
}): React.JSX.Element {
  useTranslation()
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const [viewport, setViewport] = useState<Viewport>({ height: 480, width: 720 })
  const [transform, setTransform] = useState<Transform>({ scale: 1, x: 0, y: 0 })
  const [focusedClusterId, setFocusedClusterId] = useState<string | null>(null)
  const dragRef = useRef<{ x: number; y: number } | null>(null)
  const clusters = useMemo(() => buildConversationKnowledgeMap(graph), [graph])
  const focusedCluster =
    clusters.find((cluster) => cluster.id === focusedClusterId) ??
    clusters.find((cluster) =>
      cluster.concepts.some((entry) => entry.concept.id === selectedConceptId)
    ) ??
    clusters[0]
  const layout = useMemo(
    () =>
      createConversationKnowledgeMapOverviewLayout(
        focusedCluster ? [focusedCluster] : [],
        viewport.width - 32
      ),
    [focusedCluster, viewport.width]
  )

  const fitMap = useCallback((): void => {
    const scale = clampScale(Math.max(0.9, Math.min(1.2, (viewport.width - 32) / layout.width)))
    setTransform({
      scale,
      x: Math.max(16, (viewport.width - layout.width * scale) / 2),
      y: Math.max(16, (viewport.height - layout.height * scale) / 2)
    })
  }, [layout.height, layout.width, viewport.height, viewport.width])

  const zoomBy = useCallback((factor: number): void => {
    setTransform((current) => ({ ...current, scale: clampScale(current.scale * factor) }))
  }, [])

  useEffect(() => {
    const element = viewportRef.current
    if (!element || typeof ResizeObserver === 'undefined') {
      return
    }
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) {
        return
      }
      setViewport({ height: entry.contentRect.height, width: entry.contentRect.width })
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    fitMap()
  }, [fitMap])

  useEffect(() => {
    const element = viewportRef.current
    if (!element) {
      return
    }
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      zoomBy(event.deltaY < 0 ? 1.12 : 1 / 1.12)
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [zoomBy])

  if (!clusters.length) {
    return (
      <div className="flex min-h-52 items-center justify-center px-6 text-center text-sm text-muted-foreground">
        {translate('conversationKnowledge.map.empty', 'No concepts are available for the map yet.')}
      </div>
    )
  }

  return (
    <div className="relative h-full min-h-0 overflow-hidden rounded-lg border border-border/60 bg-transparent">
      {clusters.length > 1 ? (
        <label className="absolute top-3 left-3 z-10 max-w-[calc(100%-8rem)] rounded-md border border-border/60 bg-background/95 px-2 py-1 text-xs shadow-xs">
          <span className="sr-only">
            {translate('conversationKnowledge.map.cluster', 'Concept cluster')}
          </span>
          <select
            className="max-w-full bg-transparent outline-none"
            value={focusedCluster?.id ?? ''}
            onChange={(event) => setFocusedClusterId(event.target.value)}
          >
            {clusters.map((cluster) => (
              <option key={cluster.id} value={cluster.id}>
                {cluster.concepts[0]?.concept.label} · {cluster.concepts.length}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <div
        ref={viewportRef}
        aria-label={translate('conversationKnowledge.map.relationships', 'Concept relationships')}
        className="h-full min-h-96 touch-none select-none outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        onPointerDown={(event) => {
          if (event.target instanceof Element && event.target.closest('button')) {
            return
          }
          event.currentTarget.setPointerCapture(event.pointerId)
          dragRef.current = { x: event.clientX - transform.x, y: event.clientY - transform.y }
        }}
        onPointerMove={(event) => {
          if (!dragRef.current) {
            return
          }
          setTransform((current) => ({
            ...current,
            x: event.clientX - dragRef.current!.x,
            y: event.clientY - dragRef.current!.y
          }))
        }}
        onPointerUp={() => {
          dragRef.current = null
        }}
        role="application"
        tabIndex={0}
      >
        <div
          className="absolute origin-top-left"
          style={{
            height: layout.height,
            transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
            width: layout.width
          }}
        >
          <svg aria-hidden="true" className="pointer-events-none absolute inset-0 size-full">
            {layout.links.map((link, index) => (
              <ConceptRelationshipLine key={index} {...link} />
            ))}
          </svg>
          {layout.nodes.map((node) => (
            <ConceptMapNode
              key={node.entry.concept.id}
              entry={node.entry}
              isSelected={node.entry.concept.id === selectedConceptId}
              onSelectConcept={onSelectConcept}
              x={node.x}
              y={node.y}
            />
          ))}
        </div>
      </div>
      <div className="absolute right-3 bottom-3 flex items-center gap-1 rounded-md border border-border/60 bg-background/95 p-1 shadow-xs">
        <MapControl
          label={translate('conversationKnowledge.map.zoomOut', 'Zoom out')}
          onClick={() => zoomBy(1 / 1.2)}
        >
          <Minus />
        </MapControl>
        <MapControl label={translate('conversationKnowledge.map.fit', 'Fit map')} onClick={fitMap}>
          <Maximize2 />
        </MapControl>
        <MapControl
          label={translate('conversationKnowledge.map.zoomIn', 'Zoom in')}
          onClick={() => zoomBy(1.2)}
        >
          <Plus />
        </MapControl>
      </div>
    </div>
  )
}

function ConceptRelationshipLine({
  evidenceCount,
  source,
  target
}: {
  evidenceCount: number
  source: { x: number; y: number }
  target: { x: number; y: number }
}): React.JSX.Element {
  const midpoint = { x: (source.x + target.x) / 2, y: (source.y + target.y) / 2 }
  return (
    <g>
      <line
        stroke="var(--border)"
        strokeWidth={Math.min(1 + evidenceCount * 0.4, 2.5)}
        x1={source.x}
        x2={target.x}
        y1={source.y}
        y2={target.y}
      />
      <g transform={`translate(${midpoint.x}, ${midpoint.y})`}>
        <rect
          fill="var(--background)"
          height="18"
          rx="9"
          stroke="var(--border)"
          width="30"
          x="-15"
          y="-9"
        />
        <text
          dominantBaseline="central"
          fill="var(--muted-foreground)"
          fontSize="10"
          textAnchor="middle"
        >
          {evidenceCount}
        </text>
      </g>
    </g>
  )
}

function ConceptMapNode({
  entry,
  isSelected,
  onSelectConcept,
  x,
  y
}: {
  entry: ConversationKnowledgeMapConcept
  isSelected: boolean
  onSelectConcept: (concept: ConversationKnowledgeGraphNode) => void
  x: number
  y: number
}): React.JSX.Element {
  const nodeSize = Math.min(112, 72 + entry.evidenceCount * 8)
  return (
    <Button
      aria-label={entry.concept.label}
      className="absolute flex flex-col items-center justify-center whitespace-normal text-center"
      data-current={isSelected || undefined}
      onClick={() => onSelectConcept(entry.concept)}
      style={{ height: nodeSize, left: x - nodeSize / 2, top: y - nodeSize / 2, width: nodeSize }}
      type="button"
      variant="concept"
    >
      <span className="line-clamp-2 max-w-full text-xs font-medium">{entry.concept.label}</span>
      <span className="mt-1 text-[10px] font-normal text-muted-foreground">
        {translate('conversationKnowledge.map.evidenceCount', '{{count}} source-backed', {
          count: entry.evidenceCount
        })}
      </span>
      {entry.verifiedEvidenceCount ? (
        <Badge className="mt-1" variant="evidence">
          {translate('conversationKnowledge.map.verifiedCount', '{{count}} verified', {
            count: entry.verifiedEvidenceCount
          })}
        </Badge>
      ) : null}
    </Button>
  )
}

function MapControl({
  children,
  label,
  onClick
}: {
  children: React.ReactNode
  label: string
  onClick: () => void
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button aria-label={label} size="icon-xs" type="button" variant="ghost" onClick={onClick}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function clampScale(value: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value))
}
