import React, { useState, useMemo } from 'react'
import {
  RotateCcw,
  Terminal,
  ArrowRight,
  Zap,
  MessageSquare,
  Keyboard,
  KeyRound,
  Filter,
  Trash2
} from 'lucide-react'
import { useA2AStore } from '../../store/a2a-traces-store'
import type { A2ALinkType } from '../../../../shared/terminal-a2a-link'

function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000)
  if (seconds < 5) return '剛剛'
  if (seconds < 60) return `${seconds} 秒前`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分鐘前`
  const hours = Math.floor(minutes / 60)
  return `${hours} 小時前`
}

function getTypeBadge(type: A2ALinkType): { label: string; icon: React.JSX.Element; color: string } {
  switch (type) {
    case 'send':
      return {
        label: 'DISPATCH 派工',
        icon: <Zap className="size-3 text-amber-400" />,
        color: 'border-amber-500/30 bg-amber-500/10 text-amber-300'
      }
    case 'message':
      return {
        label: 'MESSAGE 傳訊',
        icon: <MessageSquare className="size-3 text-sky-400" />,
        color: 'border-sky-500/30 bg-sky-500/10 text-sky-300'
      }
    case 'type':
      return {
        label: 'INPUT 輸入',
        icon: <Keyboard className="size-3 text-purple-400" />,
        color: 'border-purple-500/30 bg-purple-500/10 text-purple-300'
      }
    case 'keys':
      return {
        label: 'KEYS 按鍵',
        icon: <KeyRound className="size-3 text-emerald-400" />,
        color: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
      }
  }
}

export function TeamActivityStream(): React.JSX.Element {
  const { recentTraces, activeLinks, replayTrace, clearTraces } = useA2AStore()
  const [filterText, setFilterText] = useState('')

  const filteredTraces = useMemo(() => {
    if (!filterText.trim()) return recentTraces
    const q = filterText.toLowerCase()
    return recentTraces.filter((t) => {
      const fromStr = `${t.from} ${t.fromIndex ?? ''}`.toLowerCase()
      const toStr = `${t.to} ${t.toIndex ?? ''}`.toLowerCase()
      const content = (t.text || '').toLowerCase()
      return fromStr.includes(q) || toStr.includes(q) || content.includes(q)
    })
  }, [recentTraces, filterText])

  const handleTakeControl = (index?: number) => {
    if (!index || typeof document === 'undefined') return
    const targetTab = document.querySelector<HTMLElement>(`[data-terminal-index="${index}"]`)
    if (targetTab) {
      targetTab.click()
    }
  }

  return (
    <div className="flex flex-col size-full overflow-hidden bg-zinc-950/40">
      {/* Top Filter & Toolbar */}
      <div className="flex items-center justify-between border-b border-zinc-800/80 px-4 py-2.5 bg-zinc-900/40">
        <div className="flex items-center gap-2 flex-1 max-w-sm">
          <Filter className="size-3.5 text-zinc-500" />
          <input
            type="text"
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            placeholder="過濾 Agent (如 @2, @5) 或指令關鍵字..."
            className="w-full bg-zinc-950/60 border border-zinc-800 rounded-md px-2.5 py-1 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-violet-500/60"
          />
          {filterText && (
            <button
              type="button"
              onClick={() => setFilterText('')}
              className="text-xs text-zinc-500 hover:text-zinc-300"
            >
              ✕
            </button>
          )}
        </div>

        <div className="flex items-center gap-2 text-xs">
          <span className="text-zinc-500 font-mono">
            共 {filteredTraces.length} 條活動
          </span>
          {recentTraces.length > 0 && (
            <button
              type="button"
              onClick={clearTraces}
              title="清除活動記錄"
              className="flex items-center gap-1 text-zinc-500 hover:text-rose-400 transition-colors p-1 rounded hover:bg-zinc-800"
            >
              <Trash2 className="size-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Activity Cards Feed */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {filteredTraces.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center text-zinc-500">
            <MessageSquare className="size-8 stroke-1 text-zinc-600 mb-2" />
            <div className="text-sm font-medium text-zinc-400">尚無跨 Agent 活動記錄</div>
            <div className="text-xs text-zinc-600 mt-1 max-w-xs">
              當終端機內的 Agent 執行跨機指令（如 orca bridge send @5）時，會即時聚合成結構化卡片。
            </div>
          </div>
        ) : (
          filteredTraces.map((trace) => {
            const isActive = activeLinks.some((l) => l.id === trace.id)
            const typeBadge = getTypeBadge(trace.type)

            return (
              <div
                key={trace.id}
                className={`group relative rounded-xl border p-3.5 transition-all shadow-sm ${
                  isActive
                    ? 'border-violet-500/60 bg-violet-500/10 ring-1 ring-violet-500/30'
                    : 'border-zinc-800/80 bg-zinc-900/60 hover:border-zinc-700 hover:bg-zinc-900/90'
                }`}
              >
                {/* Header: Sender -> Recipient + Badge + Time */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 font-mono text-xs">
                    <div className="flex items-center gap-1.5 rounded-md bg-zinc-950/80 border border-violet-500/30 px-2 py-0.5 font-bold text-violet-300">
                      <span>#{trace.fromIndex ?? trace.from}</span>
                      {trace.fromLabel && (
                        <span className="text-[10px] text-zinc-400 font-normal">
                          ({trace.fromLabel})
                        </span>
                      )}
                    </div>

                    <ArrowRight className="size-3 text-zinc-500" />

                    <div className="flex items-center gap-1.5 rounded-md bg-zinc-950/80 border border-emerald-500/30 px-2 py-0.5 font-bold text-emerald-300">
                      <span>#{trace.toIndex ?? trace.to}</span>
                      {trace.toLabel && (
                        <span className="text-[10px] text-zinc-400 font-normal">
                          ({trace.toLabel})
                        </span>
                      )}
                    </div>

                    <span
                      className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium border ${typeBadge.color}`}
                    >
                      {typeBadge.icon}
                      {typeBadge.label}
                    </span>
                  </div>

                  <span className="text-[11px] text-zinc-500 font-mono">
                    {formatTimeAgo(trace.timestamp)}
                  </span>
                </div>

                {/* Message / Code Body */}
                {trace.text && (
                  <div className="mt-2.5 rounded-lg bg-zinc-950/80 border border-zinc-800/80 p-2.5 font-mono text-xs text-zinc-200 overflow-x-auto select-text">
                    {trace.text}
                  </div>
                )}

                {/* Action Footer */}
                <div className="mt-2.5 flex items-center justify-between pt-1 border-t border-zinc-800/40 text-xs">
                  <span className="text-[10px] text-zinc-600 font-mono">
                    ID: {trace.id.slice(0, 16)}...
                  </span>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => replayTrace(trace.id)}
                      className="flex items-center gap-1 rounded px-2 py-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition-colors"
                      title="重播視覺連線"
                    >
                      <RotateCcw className="size-3" />
                      <span>重播</span>
                    </button>

                    {trace.toIndex && (
                      <button
                        type="button"
                        onClick={() => handleTakeControl(trace.toIndex)}
                        className="flex items-center gap-1 rounded bg-zinc-800/70 hover:bg-violet-600/30 border border-zinc-700/60 hover:border-violet-500/40 px-2 py-1 text-zinc-300 hover:text-violet-200 transition-colors"
                        title={`切換至目標終端 #${trace.toIndex}`}
                      >
                        <Terminal className="size-3" />
                        <span>接管 #{trace.toIndex}</span>
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
