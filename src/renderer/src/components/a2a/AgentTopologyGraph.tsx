import React, { useMemo, useState } from 'react'
import { Play, Terminal, ArrowRight } from 'lucide-react'
import { useA2AStore } from '../../store/a2a-traces-store'
import { useAppStore } from '../../store'
import { PRESET_TAB_COLORS } from '../tab-bar/tab-colors'
import type { A2ALinkEvent } from '../../../../shared/terminal-a2a-link'

export type AgentNodeData = {
  index: number
  label: string
  role: string
  isActive: boolean
  isCommunicating: boolean
  lastSeenAt: number
  color?: string | null
  tabId?: string
}

function getRoleName(index: number, fallbackLabel?: string): string {
  if (fallbackLabel && fallbackLabel.trim() && !fallbackLabel.startsWith('@')) {
    return fallbackLabel
  }
  switch (index) {
    case 1:
      return 'Supervisor (總調度)'
    case 2:
      return 'Worker (執行專員)'
    case 3:
      return 'Researcher (資料研究)'
    case 4:
      return 'Architect (架構工程)'
    case 5:
      return 'Test & QA (測試驗證)'
    case 8:
      return 'Reviewer (審查把關)'
    default:
      return `Agent #${index}`
  }
}

export function AgentTopologyGraph(): React.JSX.Element {
  const { activeLinks, recentTraces, selectedAgentIndex, setSelectedAgentIndex, replayTrace } =
    useA2AStore()
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null)

  const tabsByWorktree = useAppStore((s) => s.tabsByWorktree)
  const activeWorktreeId = Object.keys(tabsByWorktree)[0] || ''
  const currentTabs = tabsByWorktree[activeWorktreeId] ?? []

  // Discover all distinct agent indexes from recent traces and DOM
  const agents = useMemo<AgentNodeData[]>(() => {
    const indexMap = new Map<number, { label?: string; lastSeen: number }>()

    // Check DOM for open tabs with terminal index
    if (typeof document !== 'undefined') {
      const tabElements = document.querySelectorAll('[data-terminal-index]')
      tabElements.forEach((el) => {
        const raw = el.getAttribute('data-terminal-index')
        const idx = raw ? Number.parseInt(raw, 10) : NaN
        if (Number.isFinite(idx) && idx > 0) {
          const tabText = el.textContent?.trim() || ''
          indexMap.set(idx, { label: tabText, lastSeen: Date.now() })
        }
      })
    }

    // Check recent traces
    for (const trace of recentTraces) {
      if (trace.fromIndex) {
        const existing = indexMap.get(trace.fromIndex)
        indexMap.set(trace.fromIndex, {
          label: trace.fromLabel || existing?.label,
          lastSeen: Math.max(existing?.lastSeen || 0, trace.timestamp)
        })
      }
      if (trace.toIndex) {
        const existing = indexMap.get(trace.toIndex)
        indexMap.set(trace.toIndex, {
          label: trace.toLabel || existing?.label,
          lastSeen: Math.max(existing?.lastSeen || 0, trace.timestamp)
        })
      }
    }

    // Default agents if none yet
    if (indexMap.size === 0) {
      indexMap.set(1, { lastSeen: Date.now() })
      indexMap.set(2, { lastSeen: Date.now() })
      indexMap.set(5, { lastSeen: Date.now() })
    }

    const sortedIndexes = Array.from(indexMap.keys()).sort((a, b) => a - b)
    const now = Date.now()

    return sortedIndexes.map((idx) => {
      const info = indexMap.get(idx)
      const isCommunicating = activeLinks.some((l) => l.fromIndex === idx || l.toIndex === idx)
      const isActive = isCommunicating || (info?.lastSeen ? now - info.lastSeen < 15000 : false)
      const tab = currentTabs[idx - 1]
      return {
        index: idx,
        label: info?.label || `@${idx}`,
        role: getRoleName(idx, info?.label),
        isActive,
        isCommunicating,
        lastSeenAt: info?.lastSeen || 0,
        color: tab?.color ?? null,
        tabId: tab?.id
      }
    })
  }, [recentTraces, activeLinks, currentTabs])

  // Compute node positions on an SVG coordinate space (680 x 380)
  const nodePositions = useMemo(() => {
    const map = new Map<number, { x: number; y: number }>()
    const count = agents.length
    const width = 680
    const height = 360
    const centerX = width / 2
    const centerY = height / 2

    if (count === 1) {
      map.set(agents[0].index, { x: centerX, y: centerY })
    } else if (count === 2) {
      map.set(agents[0].index, { x: centerX - 160, y: centerY })
      map.set(agents[1].index, { x: centerX + 160, y: centerY })
    } else if (count === 3) {
      // Triangle with Supervisor at top
      map.set(agents[0].index, { x: centerX, y: centerY - 90 })
      map.set(agents[1].index, { x: centerX - 160, y: centerY + 80 })
      map.set(agents[2].index, { x: centerX + 160, y: centerY + 80 })
    } else {
      // Circular layout with index 1 placed at the top
      const radiusX = 220
      const radiusY = 110
      agents.forEach((agent, i) => {
        // Offset angle so the first agent is at top (-PI / 2)
        const angle = -Math.PI / 2 + (i * 2 * Math.PI) / count
        const x = centerX + radiusX * Math.cos(angle)
        const y = centerY + radiusY * Math.sin(angle)
        map.set(agent.index, { x, y })
      })
    }
    return map
  }, [agents])

  // Unique directed edges based on recent traces
  const edges = useMemo(() => {
    const edgeMap = new Map<
      string,
      {
        id: string
        fromIndex: number
        toIndex: number
        latestTrace: A2ALinkEvent
        isActive: boolean
        count: number
      }
    >()

    for (const trace of recentTraces) {
      if (!trace.fromIndex || !trace.toIndex || trace.fromIndex === trace.toIndex) {
        continue
      }
      const key = `${trace.fromIndex}->${trace.toIndex}`
      const existing = edgeMap.get(key)
      const isActive = activeLinks.some(
        (l) => l.fromIndex === trace.fromIndex && l.toIndex === trace.toIndex
      )

      if (!existing) {
        edgeMap.set(key, {
          id: key,
          fromIndex: trace.fromIndex,
          toIndex: trace.toIndex,
          latestTrace: trace,
          isActive,
          count: 1
        })
      } else {
        existing.count += 1
        if (isActive) {
          existing.isActive = true
        }
      }
    }

    return Array.from(edgeMap.values())
  }, [recentTraces, activeLinks])

  // Switch to terminal tab
  const handleTakeControl = (index: number) => {
    if (typeof document === 'undefined') return
    const targetTab = document.querySelector<HTMLElement>(`[data-terminal-index="${index}"]`)
    if (targetTab) {
      targetTab.click()
    }
  }

  const selectedAgent = agents.find((a) => a.index === selectedAgentIndex)
  const agentTraces = useMemo(() => {
    if (!selectedAgentIndex) return []
    return recentTraces.filter(
      (t) => t.fromIndex === selectedAgentIndex || t.toIndex === selectedAgentIndex
    )
  }, [selectedAgentIndex, recentTraces])

  return (
    <div className="relative flex flex-col size-full overflow-hidden bg-zinc-950/60 select-none">
      {/* Topology Canvas */}
      <div className="relative flex-1 min-h-[360px] flex items-center justify-center p-4">
        <svg
          viewBox="0 0 680 360"
          className="w-full h-full max-h-[380px] pointer-events-auto"
          style={{ filter: 'drop-shadow(0 0 12px rgba(139, 92, 246, 0.15))' }}
        >
          <defs>
            <linearGradient id="topo-edge-active" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#c084fc" stopOpacity="0.9" />
              <stop offset="50%" stopColor="#38bdf8" stopOpacity="1" />
              <stop offset="100%" stopColor="#34d399" stopOpacity="0.9" />
            </linearGradient>

            <linearGradient id="topo-edge-idle" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#64748b" stopOpacity="0.4" />
              <stop offset="100%" stopColor="#475569" stopOpacity="0.4" />
            </linearGradient>

            <marker
              id="topo-arrow-active"
              viewBox="0 0 10 10"
              refX="18"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 1.5 L 9 5 L 0 8.5 z" fill="#38bdf8" />
            </marker>

            <marker
              id="topo-arrow-idle"
              viewBox="0 0 10 10"
              refX="18"
              refY="5"
              markerWidth="5"
              markerHeight="5"
              orient="auto-start-reverse"
            >
              <path d="M 0 2 L 8 5 L 0 8 z" fill="#64748b" />
            </marker>
          </defs>

          {/* Background Grid Pattern */}
          <pattern id="topo-grid" width="30" height="30" patternUnits="userSpaceOnUse">
            <circle cx="15" cy="15" r="0.8" fill="#3f3f46" opacity="0.3" />
          </pattern>
          <rect width="680" height="360" fill="url(#topo-grid)" />

          {/* Directed Edges */}
          {edges.map((edge) => {
            const p1 = nodePositions.get(edge.fromIndex)
            const p2 = nodePositions.get(edge.toIndex)
            if (!p1 || !p2) return null

            // Calculate curved path
            const dx = p2.x - p1.x
            const dy = p2.y - p1.y
            const cx = (p1.x + p2.x) / 2 - dy * 0.18
            const cy = (p1.y + p2.y) / 2 + dx * 0.18
            const pathD = `M ${p1.x} ${p1.y} Q ${cx} ${cy} ${p2.x} ${p2.y}`

            const isHovered = hoveredEdgeId === edge.id
            const isEdgeSelected =
              selectedAgentIndex === edge.fromIndex || selectedAgentIndex === edge.toIndex

            return (
              <g
                key={edge.id}
                className="cursor-pointer transition-opacity"
                onMouseEnter={() => setHoveredEdgeId(edge.id)}
                onMouseLeave={() => setHoveredEdgeId(null)}
                onClick={() => replayTrace(edge.latestTrace.id)}
              >
                {/* Thick invisible hover target */}
                <path d={pathD} fill="none" stroke="transparent" strokeWidth="24" />

                {/* Visible Edge Line */}
                <path
                  d={pathD}
                  fill="none"
                  stroke={
                    edge.isActive
                      ? 'url(#topo-edge-active)'
                      : isEdgeSelected
                        ? '#a855f7'
                        : 'url(#topo-edge-idle)'
                  }
                  strokeWidth={edge.isActive ? 3 : isEdgeSelected ? 2.5 : 1.5}
                  strokeDasharray={edge.isActive ? '6 4' : undefined}
                  markerEnd={edge.isActive ? 'url(#topo-arrow-active)' : 'url(#topo-arrow-idle)'}
                  style={
                    edge.isActive
                      ? {
                          animation: 'a2a-dash-flow 1.2s linear infinite'
                        }
                      : undefined
                  }
                />

                {/* Animated Packet on Active Edge */}
                {edge.isActive && (
                  <circle r="4" fill="#ffffff" stroke="#38bdf8" strokeWidth="2">
                    <animateMotion path={pathD} dur="1.2s" repeatCount="indefinite" />
                  </circle>
                )}

                {/* Mid-point communication label */}
                {(edge.isActive || isHovered) && (
                  <g transform={`translate(${cx}, ${cy})`}>
                    <rect
                      x="-55"
                      y="-11"
                      width="110"
                      height="22"
                      rx="11"
                      fill="#18181b"
                      stroke={edge.isActive ? '#38bdf8' : '#71717a'}
                      strokeWidth="1"
                    />
                    <text
                      x="0"
                      y="3.5"
                      textAnchor="middle"
                      fill="#e4e4e7"
                      fontSize="9"
                      fontFamily="monospace"
                    >
                      {edge.latestTrace.text?.slice(0, 14) || edge.latestTrace.type.toUpperCase()}
                    </text>
                  </g>
                )}
              </g>
            )
          })}

          {/* Agent Nodes */}
          {agents.map((agent) => {
            const pos = nodePositions.get(agent.index)
            if (!pos) return null

            const isSelected = selectedAgentIndex === agent.index
            return (
              <g
                key={`node-${agent.index}`}
                transform={`translate(${pos.x}, ${pos.y})`}
                className="cursor-pointer"
                onClick={() =>
                  setSelectedAgentIndex(selectedAgentIndex === agent.index ? null : agent.index)
                }
              >
                {/* Ping / Radar ring if active */}
                {agent.isCommunicating && (
                  <circle r="36" fill="none" stroke="#c084fc" strokeWidth="1.5">
                    <animate
                      attributeName="r"
                      from="28"
                      to="44"
                      dur="1.5s"
                      repeatCount="indefinite"
                    />
                    <animate
                      attributeName="opacity"
                      from="0.8"
                      to="0"
                      dur="1.5s"
                      repeatCount="indefinite"
                    />
                  </circle>
                )}

                {/* Base circle */}
                <circle
                  r="28"
                  fill="#18181b"
                  stroke={
                    isSelected
                      ? (agent.color || '#38bdf8')
                      : agent.color
                        ? agent.color
                        : agent.isCommunicating
                          ? '#a855f7'
                          : agent.isActive
                            ? '#10b981'
                            : '#3f3f46'
                  }
                  strokeWidth={isSelected ? 3.5 : agent.color ? 2.5 : 2}
                  filter="drop-shadow(0 4px 6px rgba(0,0,0,0.5))"
                />

                {/* Inner Icon / Index Badge */}
                <text
                  x="0"
                  y="-4"
                  textAnchor="middle"
                  fill="#ffffff"
                  fontSize="13"
                  fontWeight="bold"
                  fontFamily="monospace"
                >
                  #{agent.index}
                </text>

                {/* Role text below circle */}
                <text
                  x="0"
                  y="12"
                  textAnchor="middle"
                  fill={agent.isActive ? '#a1a1aa' : '#71717a'}
                  fontSize="8"
                  fontWeight="600"
                >
                  {agent.role.split(' ')[0]}
                </text>

                {/* Status Dot */}
                <circle
                  cx="20"
                  cy="-18"
                  r="5"
                  fill={
                    agent.isCommunicating ? '#a855f7' : agent.isActive ? '#10b981' : '#71717a'
                  }
                  stroke="#18181b"
                  strokeWidth="1.5"
                />
              </g>
            )
          })}
        </svg>
      </div>

      {/* Selected Agent Inspector Panel */}
      {selectedAgent && (
        <div className="border-t border-zinc-800/80 bg-zinc-900/80 p-3 backdrop-blur-md transition-all">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="flex size-8 items-center justify-center rounded-full bg-violet-600/20 font-mono text-xs font-bold text-violet-300 border border-violet-500/30">
                #{selectedAgent.index}
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-sm text-zinc-100">{selectedAgent.role}</span>
                  <span
                    className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.2 text-[10px] font-medium ${
                      selectedAgent.isCommunicating
                        ? 'bg-purple-500/20 text-purple-300 border border-purple-500/30'
                        : selectedAgent.isActive
                          ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                          : 'bg-zinc-800 text-zinc-400'
                    }`}
                  >
                    <span className="size-1.5 rounded-full bg-current" />
                    {selectedAgent.isCommunicating
                      ? '通訊中'
                      : selectedAgent.isActive
                        ? '就緒'
                        : '待命中'}
                  </span>
                </div>
                <div className="text-xs text-zinc-400 font-mono">
                  標識: @{selectedAgent.index} · 相關互動: {agentTraces.length} 次
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2">
              {selectedAgent.tabId && (
                <div className="flex items-center gap-1.5 mr-2 rounded-md bg-zinc-800/60 px-2 py-1 border border-zinc-700/50">
                  <span className="text-[11px] text-zinc-400 font-medium">框色:</span>
                  <div className="flex items-center gap-1">
                    {PRESET_TAB_COLORS.slice(0, 8).map((c) => (
                      <button
                        key={c.label}
                        type="button"
                        className={`size-3 rounded-full border transition-transform hover:scale-125 ${
                          selectedAgent.color === c.value
                            ? 'ring-1 ring-white ring-offset-1 ring-offset-zinc-900'
                            : ''
                        } ${c.value ? 'border-transparent' : 'border-zinc-500 bg-transparent'}`}
                        style={c.value ? { backgroundColor: c.value } : undefined}
                        onClick={() => {
                          if (selectedAgent.tabId) {
                            useAppStore.getState().setTabColor(selectedAgent.tabId, c.value)
                          }
                        }}
                        title={c.label}
                      />
                    ))}
                    <label
                      className="relative flex size-3 cursor-pointer items-center justify-center rounded-full border border-dashed border-zinc-500 hover:border-zinc-300"
                      title="自訂色彩"
                    >
                      <span className="text-[7px] leading-none text-zinc-400">+</span>
                      <input
                        type="color"
                        className="absolute inset-0 opacity-0 cursor-pointer"
                        value={selectedAgent.color ?? '#3b82f6'}
                        onChange={(e) => {
                          if (selectedAgent.tabId) {
                            useAppStore.getState().setTabColor(selectedAgent.tabId, e.target.value)
                          }
                        }}
                      />
                    </label>
                  </div>
                </div>
              )}
              <button
                type="button"
                onClick={() => handleTakeControl(selectedAgent.index)}
                className="flex items-center gap-1.5 rounded-lg border border-violet-500/40 bg-violet-600/20 px-3 py-1.5 text-xs font-medium text-violet-200 hover:bg-violet-600/30 transition-colors shadow-sm"
              >
                <Terminal className="size-3.5" />
                <span>接管終端 (Take Control)</span>
              </button>
              <button
                type="button"
                onClick={() => setSelectedAgentIndex(null)}
                className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
              >
                ✕
              </button>
            </div>
          </div>

          {/* Mini interaction list */}
          {agentTraces.length > 0 && (
            <div className="mt-2.5 max-h-24 overflow-y-auto space-y-1 pr-1">
              {agentTraces.slice(0, 3).map((t) => (
                <div
                  key={t.id}
                  className="flex items-center justify-between rounded bg-zinc-950/40 px-2 py-1 text-[11px] font-mono border border-zinc-800/40"
                >
                  <div className="flex items-center gap-1.5">
                    <span className="text-violet-400">#{t.fromIndex ?? t.from}</span>
                    <ArrowRight className="size-3 text-zinc-500" />
                    <span className="text-emerald-400">#{t.toIndex ?? t.to}</span>
                    <span className="text-zinc-300 truncate max-w-xs">{t.text || t.type}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => replayTrace(t.id)}
                    className="text-zinc-500 hover:text-zinc-300"
                    title="重播動效"
                  >
                    <Play className="size-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
