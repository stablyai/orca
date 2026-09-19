import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Radio, X, RotateCcw, Send, MessageSquare, Maximize2 } from 'lucide-react'
import { useA2AStore } from '../../store/a2a-traces-store'
import type { A2ALinkEvent } from '../../../../shared/terminal-a2a-link'

type Point = { x: number; y: number }

type ResolvedLinkGeometry = {
  link: A2ALinkEvent
  p1: Point
  p2: Point
  midX: number
  midY: number
  pathD: string
  isFallback: boolean
}

function resolvePointFromElement(el: Element | null): Point | null {
  if (!el) {
    return null
  }
  const rect = el.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) {
    return null
  }
  return {
    x: rect.left + rect.width / 2,
    y: rect.bottom > 50 && rect.top < 50 ? rect.bottom - 2 : rect.top + rect.height / 2
  }
}

function findTerminalElement(
  targetIndex?: number,
  targetName?: string
): Element | null {
  if (typeof document === 'undefined') {
    return null
  }
  if (targetIndex !== undefined) {
    const el = document.querySelector(`[data-terminal-index="${targetIndex}"]`)
    if (el) {
      return el
    }
  }
  if (targetName) {
    const clean = targetName.replace(/^[@#]/, '')
    const byIndex = document.querySelector(`[data-terminal-index="${clean}"]`)
    if (byIndex) {
      return byIndex
    }
    const byTitle = document.querySelector(`[title*="${targetName}"]`)
    if (byTitle) {
      return byTitle
    }
  }
  return null
}

export function A2AConnectionOverlay(): React.JSX.Element | null {
  const activeLinks = useA2AStore((s) => s.activeLinks)
  const recentTraces = useA2AStore((s) => s.recentTraces)
  const removeActiveLink = useA2AStore((s) => s.removeActiveLink)
  const replayTrace = useA2AStore((s) => s.replayTrace)
  const clearTraces = useA2AStore((s) => s.clearTraces)
  const addTrace = useA2AStore((s) => s.addTrace)
  const setHubOpen = useA2AStore((s) => s.setHubOpen)

  const [hudOpen, setHudOpen] = useState(false)
  const [, setTick] = useState(0)

  // Re-measure positions on window resize or periodic animation frame
  useEffect(() => {
    if (activeLinks.length === 0) {
      return
    }
    const handleResize = (): void => setTick((t) => t + 1)
    window.addEventListener('resize', handleResize)
    const interval = setInterval(() => setTick((t) => t + 1), 300)
    return () => {
      window.removeEventListener('resize', handleResize)
      clearInterval(interval)
    }
  }, [activeLinks.length])

  const geometries = useMemo<ResolvedLinkGeometry[]>(() => {
    const windowWidth = typeof window !== 'undefined' ? window.innerWidth : 1000

    return activeLinks.map((link, idx) => {
      const elFrom = findTerminalElement(link.fromIndex, link.from)
      const elTo = findTerminalElement(link.toIndex, link.to)

      let p1 = resolvePointFromElement(elFrom)
      let p2 = resolvePointFromElement(elTo)
      let isFallback = false

      if (!p1 || !p2) {
        // Fallback layout across top header
        isFallback = true
        const spreadOffset = (idx % 3) * 20
        p1 = p1 ?? { x: windowWidth * 0.25 + spreadOffset, y: 38 }
        p2 = p2 ?? { x: windowWidth * 0.75 - spreadOffset, y: 38 }
      }

      // Compute curve path
      const dx = Math.abs(p2.x - p1.x)
      const dy = Math.abs(p2.y - p1.y)

      let pathD = ''
      let midX = (p1.x + p2.x) / 2
      let midY = (p1.y + p2.y) / 2

      if (dy < 30) {
        // Both endpoints are along a horizontal line (e.g. top TabBar)
        // Draw a pleasant hanging arc dipping into the workspace
        const arcDepth = Math.min(140, Math.max(50, dx * 0.22)) + (idx % 4) * 16
        midY = Math.max(p1.y, p2.y) + arcDepth
        pathD = `M ${p1.x} ${p1.y} Q ${midX} ${midY} ${p2.x} ${p2.y}`
      } else {
        // Multi-level curve (e.g. tab to split pane or pane to pane)
        const controlXOffset = (p2.x - p1.x) * 0.5
        pathD = `M ${p1.x} ${p1.y} C ${p1.x + controlXOffset} ${p1.y}, ${p2.x - controlXOffset} ${p2.y}, ${p2.x} ${p2.y}`
      }

      return {
        link,
        p1,
        p2,
        midX,
        midY,
        pathD,
        isFallback
      }
    })
  }, [activeLinks])

  const handleTestTrigger = useCallback(
    (from: string, to: string, text: string) => {
      addTrace({
        from,
        to,
        type: 'send',
        text,
        durationMs: 5000
      })
    },
    [addTrace]
  )

  const hasAnyTrace = activeLinks.length > 0 || recentTraces.length > 0

  return (
    <div
      className="a2a-connection-container pointer-events-none fixed inset-0 z-50 overflow-hidden"
      data-testid="a2a-connection-overlay"
    >
      {/* SVG Canvas for Connection Beams */}
      {geometries.length > 0 && (
        <svg
          className="absolute inset-0 size-full pointer-events-none"
          style={{ filter: 'drop-shadow(0 0 10px rgba(139, 92, 246, 0.3))' }}
        >
          <defs>
            <linearGradient id="a2a-beam-gradient" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#c084fc" stopOpacity="0.95" />
              <stop offset="40%" stopColor="#38bdf8" stopOpacity="1" />
              <stop offset="100%" stopColor="#34d399" stopOpacity="0.95" />
            </linearGradient>

            <filter id="a2a-glow" x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur stdDeviation="4" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>

            <marker
              id="a2a-arrow-head"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 1.5 L 9 5 L 0 8.5 z" fill="#34d399" />
            </marker>
          </defs>

          {geometries.map(({ link, p1, p2, pathD }) => (
            <g key={link.id} className="a2a-link-beam">
              {/* Outer soft glow line */}
              <path
                d={pathD}
                fill="none"
                stroke="url(#a2a-beam-gradient)"
                strokeWidth="7"
                strokeOpacity="0.35"
                filter="url(#a2a-glow)"
              />

              {/* Foreground animated dashed line */}
              <path
                d={pathD}
                fill="none"
                stroke="url(#a2a-beam-gradient)"
                strokeWidth="2.5"
                strokeDasharray="8 6"
                markerEnd="url(#a2a-arrow-head)"
                style={{
                  animation: 'a2a-dash-flow 1.5s linear infinite'
                }}
              />

              {/* Origin (#from) glowing ring and radar ping */}
              <circle cx={p1.x} cy={p1.y} r="14" fill="none" stroke="#c084fc" strokeWidth="1.5">
                <animate attributeName="r" from="4" to="20" dur="1.8s" repeatCount="indefinite" />
                <animate
                  attributeName="opacity"
                  from="0.9"
                  to="0"
                  dur="1.8s"
                  repeatCount="indefinite"
                />
              </circle>
              <circle cx={p1.x} cy={p1.y} r="5" fill="#a855f7" stroke="#ffffff" strokeWidth="1.5" />

              {/* Target (#to) receiving pulse rings */}
              <circle cx={p2.x} cy={p2.y} r="16" fill="none" stroke="#34d399" strokeWidth="1.5">
                <animate attributeName="r" from="6" to="24" dur="1.8s" repeatCount="indefinite" />
                <animate
                  attributeName="opacity"
                  from="0.9"
                  to="0"
                  dur="1.8s"
                  repeatCount="indefinite"
                />
              </circle>
              <circle cx={p2.x} cy={p2.y} r="6" fill="#10b981" stroke="#ffffff" strokeWidth="1.5" />

              {/* Traveling light particle / energy packet */}
              <circle r="4.5" fill="#ffffff" stroke="#38bdf8" strokeWidth="2">
                <animateMotion path={pathD} dur="1.4s" repeatCount="indefinite" />
              </circle>
            </g>
          ))}
        </svg>
      )}

      {/* Floating Action Badges at curve midpoints */}
      {geometries.map(({ link, midX, midY }) => (
        <div
          key={`badge-${link.id}`}
          style={{
            position: 'absolute',
            left: `${midX}px`,
            top: `${midY}px`,
            transform: 'translate(-50%, -50%)'
          }}
          className="pointer-events-auto flex items-center gap-2 rounded-full border border-violet-500/40 bg-zinc-950/90 px-3 py-1 text-xs font-mono text-zinc-100 shadow-xl backdrop-blur-md transition-all hover:scale-105"
        >
          {/* Source badge */}
          <span className="flex items-center gap-1 rounded bg-violet-500/20 px-1.5 py-0.5 font-bold text-violet-300 border border-violet-500/30">
            {link.fromIndex !== undefined ? `#${link.fromIndex}` : link.from}
          </span>

          <span className="text-zinc-400">➔</span>

          {/* Target badge */}
          <span className="flex items-center gap-1 rounded bg-emerald-500/20 px-1.5 py-0.5 font-bold text-emerald-300 border border-emerald-500/30">
            {link.toIndex !== undefined ? `#${link.toIndex}` : link.to}
          </span>

          {/* Action icon and text preview */}
          <div className="flex items-center gap-1.5 text-zinc-300 pl-1 border-l border-zinc-700/60 max-w-[220px] truncate">
            {link.type === 'send' && <Send className="size-3 text-cyan-400 shrink-0" />}
            {link.type === 'message' && <MessageSquare className="size-3 text-emerald-400 shrink-0" />}
            {link.type === 'type' && <span className="text-[10px] text-amber-400">⌨</span>}
            <span className="truncate text-[11px]">{link.text || link.type}</span>
          </div>

          {/* Close button */}
          <button
            type="button"
            onClick={() => removeActiveLink(link.id)}
            className="ml-1 rounded-full p-0.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
            aria-label="Dismiss trace"
          >
            <X className="size-3" />
          </button>
        </div>
      ))}

      {/* Floating A2A HUD Trigger & History Widget (Bottom-Right) */}
      <div className="pointer-events-auto absolute bottom-4 right-4 z-50 flex flex-col items-end gap-2">
        {hudOpen && (
          <div className="flex w-80 flex-col rounded-xl border border-zinc-800 bg-zinc-950/95 p-3.5 text-zinc-200 shadow-2xl backdrop-blur-xl animate-in fade-in slide-in-from-bottom-2 duration-150">
            <div className="flex items-center justify-between pb-2 border-b border-zinc-800/80">
              <div className="flex items-center gap-2">
                <Radio className="size-4 text-violet-400 animate-pulse" />
                <span className="text-xs font-semibold text-zinc-100">A2A 通訊軌跡 (Trace)</span>
                {activeLinks.length > 0 && (
                  <span className="rounded-full bg-violet-500/20 px-1.5 py-0.2 text-[10px] font-mono font-medium text-violet-300 border border-violet-500/30">
                    {activeLinks.length} active
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setHubOpen(true)}
                  className="flex items-center gap-1 rounded bg-violet-600/20 hover:bg-violet-600/30 border border-violet-500/40 px-1.5 py-0.5 text-[10px] text-violet-300 transition-colors"
                  title="展開完整 A2A 調度中樞 (Grokbot Hub)"
                >
                  <Maximize2 className="size-2.5" />
                  <span>調度中樞</span>
                </button>
                {recentTraces.length > 0 && (
                  <button
                    type="button"
                    onClick={clearTraces}
                    className="rounded px-1.5 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                  >
                    Clear
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setHudOpen(false)}
                  className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                  aria-label="Close HUD"
                >
                  <X className="size-3.5" />
                </button>
              </div>
            </div>

            {/* Quick Demo Triggers */}
            <div className="my-2 flex items-center gap-1.5">
              <span className="text-[10px] text-zinc-400">測試連線:</span>
              <button
                type="button"
                onClick={() => handleTestTrigger('@2', '@5', 'npm test')}
                className="flex items-center gap-1 rounded bg-violet-500/15 hover:bg-violet-500/25 px-2 py-0.5 text-[10px] font-mono text-violet-300 border border-violet-500/30 transition-colors"
              >
                #2 ➔ #5
              </button>
              <button
                type="button"
                onClick={() => handleTestTrigger('@2', '@8', 'review ready')}
                className="flex items-center gap-1 rounded bg-cyan-500/15 hover:bg-cyan-500/25 px-2 py-0.5 text-[10px] font-mono text-cyan-300 border border-cyan-500/30 transition-colors"
              >
                #2 ➔ #8
              </button>
              <button
                type="button"
                onClick={() => {
                  handleTestTrigger('@2', '@5', 'task: build')
                  setTimeout(() => handleTestTrigger('@2', '@8', 'task: test'), 200)
                }}
                className="flex items-center gap-1 rounded bg-emerald-500/15 hover:bg-emerald-500/25 px-2 py-0.5 text-[10px] font-mono text-emerald-300 border border-emerald-500/30 transition-colors"
              >
                分派 2➔5,8
              </button>
            </div>

            {/* Recent Trace History List */}
            <div className="max-h-56 overflow-y-auto space-y-1.5 pr-1">
              {recentTraces.length === 0 ? (
                <div className="py-6 text-center text-xs text-zinc-500">
                  尚無 Agent 溝通記錄
                  <div className="mt-1 text-[10px] text-zinc-600">
                    使用 orca bridge send @5 指令即可觸發連線痕跡
                  </div>
                </div>
              ) : (
                recentTraces.map((trace) => {
                  const isActive = activeLinks.some((l) => l.id === trace.id)
                  return (
                    <div
                      key={trace.id}
                      className={`group flex items-center justify-between rounded-lg p-2 text-xs border transition-all ${
                        isActive
                          ? 'border-violet-500/50 bg-violet-500/10'
                          : 'border-zinc-800/80 bg-zinc-900/50 hover:border-zinc-700'
                      }`}
                    >
                      <div className="flex flex-col min-w-0 pr-2">
                        <div className="flex items-center gap-1.5 font-mono">
                          <span className="font-bold text-violet-300">
                            {trace.fromIndex !== undefined ? `#${trace.fromIndex}` : trace.from}
                          </span>
                          <span className="text-zinc-500">➔</span>
                          <span className="font-bold text-emerald-300">
                            {trace.toIndex !== undefined ? `#${trace.toIndex}` : trace.to}
                          </span>
                          <span className="text-[10px] text-zinc-500">
                            {trace.type.toUpperCase()}
                          </span>
                        </div>
                        {trace.text && (
                          <span className="truncate text-[11px] text-zinc-300 mt-0.5">
                            {trace.text}
                          </span>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => replayTrace(trace.id)}
                        title="重新播放通訊連線"
                        className="rounded p-1 text-zinc-400 opacity-0 group-hover:opacity-100 hover:bg-zinc-800 hover:text-zinc-200 transition-opacity"
                      >
                        <RotateCcw className="size-3" />
                      </button>
                    </div>
                  )
                })
              )}
            </div>
          </div>
        )}

        {/* Floating Mini Trigger Badge */}
        {hasAnyTrace && !hudOpen && (
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setHudOpen(true)}
              data-testid="a2a-hud-trigger"
              className="flex items-center gap-1.5 rounded-full border border-violet-500/40 bg-zinc-950/80 px-2.5 py-1 text-xs font-mono text-violet-300 shadow-lg backdrop-blur-md transition-all hover:scale-105 hover:bg-zinc-900"
            >
              <Radio className="size-3 text-violet-400 animate-pulse" />
              <span>A2A Trace</span>
              {activeLinks.length > 0 && (
                <span className="rounded-full bg-violet-500/30 px-1.5 py-0.2 text-[10px] font-bold text-violet-200">
                  {activeLinks.length}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => setHubOpen(true)}
              title="開啟視覺化調度中樞 (Grokbot Hub)"
              className="flex items-center justify-center size-6 rounded-full border border-violet-500/40 bg-violet-600/30 text-violet-200 hover:bg-violet-600/50 shadow-md backdrop-blur-md transition-transform hover:scale-110"
            >
              <Maximize2 className="size-3" />
            </button>
          </div>
        )}
      </div>

      <style>{`
        @keyframes a2a-dash-flow {
          from {
            stroke-dashoffset: 28;
          }
          to {
            stroke-dashoffset: 0;
          }
        }
      `}</style>
    </div>
  )
}
