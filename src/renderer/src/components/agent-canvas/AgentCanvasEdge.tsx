import { BaseEdge, EdgeLabelRenderer, type Edge, type EdgeProps } from '@xyflow/react'
import { Link2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import type { CanvasNode } from './agent-canvas-document'
import { AgentCanvasConnection } from './AgentCanvasConnection'
import { canvasConnectionPath } from './canvas-connection-geometry'

export type CanvasFlowEdge = Edge<
  {
    source: CanvasNode
    target: CanvasNode
    sourceCard?: DashboardCard
    targetCard?: DashboardCard
    readOnly: boolean
    reciprocal: boolean
    browserControl?: boolean
    scope?: string
    paused?: boolean
    onOpen: (id: string | null) => void
    onRemove: (id: string) => void
  },
  'context'
>

export function AgentCanvasEdge(props: EdgeProps<CanvasFlowEdge>) {
  const contentRef = useRef<HTMLDivElement>(null)
  const { id, data, selected, markerEnd, markerStart } = props
  if (!data) {
    return null
  }
  const { path, x, y } = canvasConnectionPath(data.source, data.target, data.reciprocal)
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        markerStart={markerStart}
        interactionWidth={24}
        style={{ strokeWidth: selected ? 2 : 1.5 }}
      />
      <EdgeLabelRenderer>
        <div
          className="nodrag nopan pointer-events-auto absolute"
          style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }}
        >
          <Popover open={selected} onOpenChange={(open) => data.onOpen(open ? id : null)}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="icon-xs"
                className="canvas-link-control rounded-full"
                aria-label={`${data.source.title} ${data.source.kind === 'agent' ? '↔' : '→'} ${data.target.title}`}
              >
                <Link2 className="size-3" />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              ref={contentRef}
              onOpenAutoFocus={(event) => {
                event.preventDefault()
                contentRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
              }}
              className="w-80 max-w-[calc(100vw-2rem)] p-0"
              side="right"
              sideOffset={12}
              collisionPadding={12}
            >
              <AgentCanvasConnection
                scope={data.scope}
                paused={data.paused}
                source={data.source}
                browserControl={data.browserControl}
                target={data.target}
                sourceCard={data.sourceCard}
                targetCard={data.targetCard}
                readOnly={data.readOnly}
                onClose={() => data.onOpen(null)}
                onRemove={() => data.onRemove(id)}
              />
            </PopoverContent>
          </Popover>
        </div>
      </EdgeLabelRenderer>
    </>
  )
}
import { useRef } from 'react'
