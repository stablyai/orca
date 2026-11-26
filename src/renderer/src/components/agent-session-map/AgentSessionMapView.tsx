import { useEffect, useMemo, useRef, useState } from 'react'
import { mapStateAt } from '../../../../shared/agent-session-map/agent-session-map-playhead'
import { layoutAgentMap } from '../../../../shared/agent-session-map/agent-session-map-layout'
import { agentMapSessionSummary } from '../../../../shared/agent-session-map/agent-session-map-session-summary'
import type { AgentMap } from '../../../../shared/agent-session-map/agent-session-map-model'
import { AgentSessionMapDetail } from './AgentSessionMapDetail'
import { AgentSessionMapGraph, AGENT_MAP_CHIP_ROW_HEIGHT } from './AgentSessionMapGraph'
import { AgentSessionMapTimeline } from './AgentSessionMapTimeline'
import { useAgentSessionMap } from './use-agent-session-map'
import { useTranslate } from '@/i18n/use-translate'

const MIN_GRAPH_WIDTH = 320

/** The switchable live map of a pane's agent session: a node graph (main agent,
 *  sub-agents, tool chips) plus a time scrubber that replays the session. Click a
 *  node for its full work detail. `playheadTs` null = live. */
export function AgentSessionMapView({
  tabId,
  paneKey,
  isVisible
}: {
  tabId: string
  paneKey: string
  isVisible: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const { map, sessionId } = useAgentSessionMap({ tabId, paneKey, isVisible })
  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-background">
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <h2 className="text-sm font-semibold text-foreground">
          {t('components.agentSessionMap.title', 'Agent Map')}
        </h2>
        {map && (
          <span className="text-xs text-muted-foreground">
            {t('components.agentSessionMap.agents.count', '{{count}} agents', {
              count: map.nodes.length
            })}
          </span>
        )}
      </div>
      {map && sessionId ? (
        // A different provider session remounts the body, so the scrub position
        // and selection reset with it instead of a post-render state adjustment.
        <AgentSessionMapBody key={sessionId} map={map} />
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
          {t('components.agentSessionMap.empty', 'No agent session in this pane')}
        </div>
      )}
    </div>
  )
}

function AgentSessionMapBody({ map }: { map: AgentMap }): React.JSX.Element {
  const t = useTranslate()
  const [playheadIndex, setPlayheadIndex] = useState<number | null>(null)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [width, setWidth] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)

  const timeline = map.timeline
  const playheadTs =
    playheadIndex === null
      ? null
      : (timeline[Math.min(playheadIndex, timeline.length - 1)]?.ts ?? null)

  useEffect(() => {
    const element = containerRef.current
    if (!element) {
      return
    }
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (rect) {
        setWidth(Math.floor(rect.width))
      }
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // The observer sits on the graph container, which flex already shrinks when the
  // detail panel opens — subtracting it again would starve the graph of width.
  const graphWidth = width > 0 ? Math.max(width, MIN_GRAPH_WIDTH) : MIN_GRAPH_WIDTH
  const layout = useMemo(
    () => layoutAgentMap(map, graphWidth, { chipRowHeight: AGENT_MAP_CHIP_ROW_HEIGHT }),
    [map, graphWidth]
  )
  const viewState = useMemo(() => mapStateAt(map, playheadTs), [map, playheadTs])
  const summary = useMemo(() => agentMapSessionSummary(map), [map])

  const selectedNode =
    selectedNodeId !== null ? (map.nodes.find((n) => n.id === selectedNodeId) ?? null) : null
  const selectedView =
    selectedNode && viewState ? viewState.nodes.find((n) => n.nodeId === selectedNode.id) : null

  return (
    <>
      <div className="flex min-h-0 flex-1">
        <div ref={containerRef} className="scrollbar-sleek min-h-0 min-w-0 flex-1 overflow-auto">
          <AgentSessionMapGraph
            map={map}
            layout={layout}
            viewState={viewState}
            selectedNodeId={selectedNodeId ?? undefined}
            onSelectNode={(id) => setSelectedNodeId((prev) => (prev === id ? null : id))}
          />
        </div>
        {selectedNode && selectedView && (
          <AgentSessionMapDetail
            node={selectedNode}
            view={selectedView}
            onClose={() => setSelectedNodeId(null)}
          />
        )}
      </div>
      {summary && (
        <div className="border-t border-border px-4 py-3">
          <div className="mb-2 flex items-center gap-3 text-xs text-muted-foreground">
            <span className="tabular-nums">
              {t('components.agentSessionMap.session.tools', '{{count}} tools', {
                count: summary.toolCallCount
              })}
            </span>
            <span className="tabular-nums">
              {t('components.agentSessionMap.session.files', '{{count}} files', {
                count: summary.filesTouched.length
              })}
            </span>
            {summary.lastPromptText && (
              <span className="min-w-0 flex-1 truncate" title={summary.lastPromptText}>
                {t('components.agentSessionMap.session.lastPrompt', 'Last prompt: {{text}}', {
                  text: summary.lastPromptText
                })}
              </span>
            )}
          </div>
          <AgentSessionMapTimeline
            timeline={map.timeline}
            playheadIndex={playheadIndex}
            onScrub={setPlayheadIndex}
          />
        </div>
      )}
    </>
  )
}
