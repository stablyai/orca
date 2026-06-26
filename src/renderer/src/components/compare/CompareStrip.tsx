import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import {
  setActivityTerminalPortals,
  type ActivityTerminalPortalTarget
} from '../activity/activity-terminal-portal'
import { getWorktreeActiveTerminalPane } from './worktree-active-pane'
import CombinedDiffViewer from '../editor/CombinedDiffViewer'

type ColumnMode = 'agent' | 'changes'

// The worktree id is `${repoUuid}::${absolutePath}`; openAllDiffs needs the path.
function worktreePathFromId(id: string): string {
  const i = id.indexOf('::')
  return i === -1 ? id : id.slice(i + 2)
}
function shortName(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts.at(-1) ?? path
}

// Renders one worktree's combined uncommitted diff (collapsible per-file
// sections) by reusing Orca's own openAllDiffs action + CombinedDiffViewer.
function ChangesPane({
  worktreeId,
  worktreePath
}: {
  worktreeId: string
  worktreePath: string
}): React.JSX.Element {
  const openAllDiffs = useAppStore((s) => s.openAllDiffs)
  const file = useAppStore((s) =>
    s.openFiles.find((f) => f.id === `${worktreeId}::all-diffs::uncommitted`)
  )
  useEffect(() => {
    openAllDiffs(worktreeId, worktreePath)
  }, [worktreeId, worktreePath, openAllDiffs])
  if (!file) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
        Loading changes…
      </div>
    )
  }
  return <CombinedDiffViewer file={file} viewStateKey={`compare:${worktreeId}`} />
}

// Side-by-side compare columns. Each column shows either its worktree's agent
// terminal (portaled in — the agent keeps running) or its combined diff. Only
// one worktree is ever "active", so there's no single-foreground collision.
export default function CompareStrip({
  worktreeIds
}: {
  worktreeIds: string[]
}): React.JSX.Element {
  const columnRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const [modes, setModes] = useState<Record<string, ColumnMode>>({})
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const changeCounts = useAppStore(
    useShallow((s) => worktreeIds.map((id) => (s.gitStatusByWorktree[id] ?? []).length))
  )
  // Primitive change-detection key (avoids the getSnapshot infinite-loop).
  const panesKey = useAppStore((s) =>
    worktreeIds
      .map((id) => {
        const pane = getWorktreeActiveTerminalPane(s, id)
        return `${id}=${pane?.paneKey ?? ''}`
      })
      .join('|')
  )

  const setColumnRef = useCallback((node: HTMLDivElement | null): void => {
    if (node) {
      columnRefs.current.set(node.dataset.compareWorktreeId ?? '', node)
    }
  }, [])

  useLayoutEffect(() => {
    const state = useAppStore.getState()
    const active = state.activeWorktreeId
    // Fail-safe: exit compare to the normal view if a compared worktree is gone
    // or the active worktree fell outside the set (e.g. last terminal closed →
    // setActiveWorktree(null)). Don't require a terminal — a column may be
    // reviewing (its active tab is the diff, not the terminal).
    const stillValid =
      worktreeIds.length >= 2 &&
      active != null &&
      worktreeIds.includes(active) &&
      worktreeIds.every((id) => state.tabsByWorktree[id] !== undefined)
    if (!stillValid) {
      state.setCompareWorktreeIds(null)
      return
    }
    const descriptors: ActivityTerminalPortalTarget[] = []
    worktreeIds.forEach((id, index) => {
      // Reviewing columns don't portal a terminal; the agent stays alive in its
      // (hidden) worktree surface and re-appears when you switch back to Agent.
      if ((modes[id] ?? 'agent') !== 'agent') {
        return
      }
      const pane = getWorktreeActiveTerminalPane(state, id)
      const target = columnRefs.current.get(id)
      if (!pane || !target) {
        return
      }
      descriptors.push({
        slotId: `compare-${index}`,
        requestToken: pane.paneKey,
        target,
        worktreeId: id,
        tabId: pane.tabId,
        paneKey: pane.paneKey,
        active: id === state.activeWorktreeId
      })
    })
    setActivityTerminalPortals(descriptors)
  }, [panesKey, worktreeIds, activeWorktreeId, modes])

  useEffect(() => () => setActivityTerminalPortals([]), [])

  return (
    <div className="absolute inset-0 z-10 flex bg-background">
      {worktreeIds.map((id, index) => {
        const mode = modes[id] ?? 'agent'
        const path = worktreePathFromId(id)
        const count = changeCounts[index] ?? 0
        const setMode = (m: ColumnMode): void => setModes((prev) => ({ ...prev, [id]: m }))
        return (
          <div
            key={id}
            className="relative flex-1 min-w-0 min-h-0 flex flex-col border-l border-border/40 first:border-l-0"
          >
            <div className="relative z-20 flex items-center gap-2 h-9 px-2 border-b border-border bg-card/60 text-xs shrink-0">
              <span
                className={`w-1.5 h-1.5 rounded-full shrink-0 ${id === activeWorktreeId ? 'bg-green-500' : 'bg-muted-foreground/40'}`}
              />
              <span
                className="font-mono text-[11px] text-muted-foreground truncate flex-1"
                title={path}
              >
                {shortName(path)}
              </span>
              <div className="flex gap-0.5 shrink-0">
                <button
                  type="button"
                  onClick={() => setMode('agent')}
                  className={`px-2 py-0.5 rounded text-[11px] ${mode === 'agent' ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50'}`}
                >
                  Agent
                </button>
                <button
                  type="button"
                  onClick={() => setMode('changes')}
                  className={`px-2 py-0.5 rounded text-[11px] flex items-center gap-1 ${mode === 'changes' ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50'}`}
                >
                  Changes
                  <span className="font-mono text-[10px] rounded-full bg-background px-1.5">
                    {count}
                  </span>
                </button>
              </div>
            </div>
            <div className="relative flex-1 min-h-0 flex flex-col">
              {mode === 'agent' ? (
                <div
                  ref={setColumnRef}
                  data-compare-worktree-id={id}
                  className="absolute inset-0"
                />
              ) : (
                <ChangesPane worktreeId={id} worktreePath={path} />
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
