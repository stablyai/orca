import { memo } from 'react'
import { Handle, NodeResizer, Position, type Node, type NodeProps } from '@xyflow/react'
import { Globe, Link2, Maximize2, StickyNote, TerminalSquare, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { agentStateLabel } from '@/components/AgentStateDot'
import { AgentTerminalPreview } from '../dashboard-popout/AgentTerminalPreview'
import {
  dashboardCardDisplayState,
  type DashboardCard
} from '../../../../shared/dashboard-snapshot'
import { translate } from '@/i18n/i18n'
import type { CanvasDocument, CanvasNode } from './agent-canvas-document'
import type { CanvasAgentCard } from './use-canvas-workspace-cards'
import { AgentCanvasConnectMenu } from './AgentCanvasConnectMenu'
import { AgentIcon } from '@/lib/agent-catalog'
import { agentTypeToIconAgent } from '@/lib/agent-status'
import { AgentCanvasAttachments } from './AgentCanvasAttachments'
import { AgentCanvasBrowser } from './AgentCanvasBrowser'

export type CanvasFlowNode = Node<
  {
    node: CanvasNode
    card?: CanvasAgentCard
    readOnly: boolean
    onEdit: (
      id: string,
      patch: Partial<Pick<CanvasNode, 'title' | 'content' | 'browserTabId'>>
    ) => void
    onReveal: (card: DashboardCard) => void
    onEditStart: () => void
    document: CanvasDocument
    onConnect: (source: string, target: string) => void
    connectingSource: CanvasNode | null
    interacting?: boolean
    onRemove: (id: string) => void
  },
  'canvas'
>

export const AgentCanvasNode = memo(function AgentCanvasNode({
  data,
  selected
}: NodeProps<CanvasFlowNode>) {
  const { node, card, readOnly, onEdit, onReveal, onEditStart } = data
  const Icon = node.kind === 'note' ? StickyNote : node.kind === 'browser' ? Globe : TerminalSquare
  return (
    <section
      data-canvas-kind={node.kind}
      className="relative flex h-full flex-col rounded-xl border border-border bg-card text-card-foreground shadow-xs"
    >
      {data.connectingSource && data.connectingSource.id !== node.id && node.kind === 'agent' && (
        <Button
          variant="ghost"
          className="nodrag nopan absolute inset-0 z-10 flex h-full w-full flex-col justify-start gap-2 rounded-xl border-2 border-dashed border-ring bg-transparent p-12 text-foreground hover:bg-transparent"
          aria-label={`${data.connectingSource.title} → ${node.title}`}
          onClick={(event) => {
            event.stopPropagation()
          }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <span className="flex max-w-full items-center gap-2 rounded-md border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-xs">
            <Link2 className="size-4" />
            {translate('agentCanvas.releaseHere', 'Release to connect')}
          </span>
        </Button>
      )}
      <NodeResizer
        onResizeStart={onEditStart}
        lineClassName="!border-transparent"
        isVisible={selected && !readOnly}
        minWidth={node.kind === 'browser' ? 480 : 240}
        minHeight={node.kind === 'browser' ? 280 : 160}
        maxWidth={1600}
        maxHeight={1200}
      />
      {node.kind === 'agent' && (
        <Handle
          type="target"
          position={Position.Left}
          aria-label={translate('agentCanvas.receive', 'Receive context')}
        />
      )}
      <header className="canvas-node-header flex h-9 shrink-0 cursor-grab items-center gap-2 border-b border-border px-3 active:cursor-grabbing">
        {node.kind === 'agent' && card?.agentType ? (
          <span
            data-canvas-agent-icon={card.agentType}
            className="flex shrink-0"
            aria-label={card.agentType}
          >
            <AgentIcon agent={agentTypeToIconAgent(card.agentType)} size={16} />
          </span>
        ) : (
          <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
          {node.kind === 'note' ? translate('agentCanvas.note', 'Note') : node.title}
        </span>
        {card && (
          <Button
            variant="ghost"
            size="icon-xs"
            className="nodrag"
            onClick={() => onReveal(card)}
            aria-label={translate('agentCanvas.openTerminal', 'Open terminal in workspace')}
          >
            <Maximize2 />
          </Button>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              className="nodrag"
              disabled={readOnly}
              aria-label={translate('agentCanvas.removeCard', 'Remove card')}
              onClick={(event) => {
                event.stopPropagation()
                data.onRemove(node.id)
              }}
            >
              <X />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {node.kind === 'agent'
              ? translate(
                  'agentCanvas.removeAgentHint',
                  'Remove from canvas · terminal stays in workspace'
                )
              : translate('agentCanvas.removeNode', 'Remove from canvas')}
          </TooltipContent>
        </Tooltip>
      </header>
      {node.kind === 'agent' ? (
        <>
          <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-2 text-[11px] text-muted-foreground">
            <span className="truncate">
              {card
                ? `${card.worktreeName} · ${card.hostLabel ?? card.hostKind ?? ''}`
                : translate('agentCanvas.unavailable', 'Session unavailable')}
            </span>
            {card && (
              <span className="shrink-0">
                {card.canvasStatusUnknown
                  ? translate('agentCanvas.terminalReady', 'Terminal')
                  : agentStateLabel(dashboardCardDisplayState(card))}
              </span>
            )}
          </div>
          {card?.ptyId ? (
            <div
              className="nodrag nopan nowheel flex min-h-0 flex-1 flex-col"
              onKeyDown={(event) => event.stopPropagation()}
            >
              <AgentTerminalPreview
                autoFocus={false}
                ptyId={card.ptyId}
                terminalInput={card.terminalInput ?? null}
                className="flex-1"
              />
            </div>
          ) : (
            <div className="scrollbar-sleek nodrag nopan nowheel min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap px-3 pb-3 text-xs text-muted-foreground">
              {card?.lastAgentMessage ||
                card?.task ||
                translate(
                  'agentCanvas.waitingTerminal',
                  'Waiting for the workspace terminal to become available.'
                )}
            </div>
          )}
        </>
      ) : node.kind === 'browser' ? (
        <AgentCanvasBrowser
          node={node}
          readOnly={readOnly}
          connecting={Boolean(data.connectingSource || data.interacting)}
          onEdit={onEdit}
        />
      ) : (
        <div className="nodrag nopan nowheel flex min-h-0 flex-1 flex-col gap-2 p-3">
          <Input
            aria-label={translate('agentCanvas.nodeTitle', 'Node title')}
            onFocus={onEditStart}
            value={node.title}
            disabled={readOnly}
            onChange={(event) => onEdit(node.id, { title: event.target.value })}
            className="h-7 border-transparent bg-transparent px-0 text-sm font-medium shadow-none dark:bg-transparent"
            maxLength={1024}
          />
          <Textarea
            aria-label={translate('agentCanvas.noteContent', 'Note content')}
            onFocus={onEditStart}
            placeholder={translate(
              'agentCanvas.notePlaceholder',
              'Write instructions, decisions, or context…'
            )}
            value={node.content}
            disabled={readOnly}
            maxLength={100_000}
            onChange={(event) => onEdit(node.id, { content: event.target.value })}
            className="scrollbar-sleek min-h-0 flex-1 resize-none border-transparent bg-transparent px-0 text-sm leading-relaxed shadow-none dark:bg-transparent"
          />
        </div>
      )}
      {node.kind === 'agent' && (
        <AgentCanvasAttachments
          nodeId={node.id}
          document={data.document}
          onConnect={data.onConnect}
        />
      )}
      <div className="nodrag nopan flex h-8 shrink-0 items-center rounded-b-xl px-2">
        <AgentCanvasConnectMenu
          sourceId={node.id}
          document={data.document}
          disabled={readOnly}
          onConnect={data.onConnect}
        />
        <span className="ml-auto px-2 text-[11px] text-muted-foreground">
          {node.kind === 'note'
            ? translate('agentCanvas.noteRole', 'Reference note')
            : translate('agentCanvas.connectionCount', '{{count}} links', {
                count: data.document.edges.filter(
                  (edge) =>
                    edge.source === node.id ||
                    (node.kind === 'agent' &&
                      edge.target === node.id &&
                      data.document.nodes.find((source) => source.id === edge.source)?.kind ===
                        'agent')
                ).length
              })}
        </span>
      </div>
      <Handle
        type="source"
        position={Position.Right}
        className="canvas-context-output"
        aria-label={translate('agentCanvas.dragPoint', 'Drag to connect to an agent')}
        onClick={(event) => event.stopPropagation()}
      />
    </section>
  )
})
