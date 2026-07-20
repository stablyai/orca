import { useCallback, useEffect, useRef } from 'react'
import type { WorktreeLayoutNode } from '../../../../shared/types'
import type { WorktreeLayoutPath } from '../../lib/worktree-layout-tree'
import { clampWorktreeSplitRatio } from '../../lib/worktree-layout-tree'
import { useAppStore } from '../../store'
import { SplitResizeHandle } from '../split-layout/SplitResizeHandle'

// Worktree-level split renderer. Mirrors TabGroupSplitLayout's SplitNode, but
// leaves are WHOLE WORKTREES. It renders only empty measured SLOTS plus resize
// handles — never the worktree surfaces themselves. Terminal.tsx keeps the flat
// mounted-surface pool and positions each visible surface over its slot's rect,
// so surfaces are re-positioned, never reparented (no xterm/webview remount).

export type WorktreePaneRect = { top: number; left: number; width: number; height: number }

function rectsEqual(a: Map<string, WorktreePaneRect>, b: Map<string, WorktreePaneRect>): boolean {
  if (a.size !== b.size) {
    return false
  }
  for (const [id, r] of a) {
    const o = b.get(id)
    if (
      !o ||
      o.top !== r.top ||
      o.left !== r.left ||
      o.width !== r.width ||
      o.height !== r.height
    ) {
      return false
    }
  }
  return true
}

function SlotNode({
  node,
  path,
  registerLeaf,
  onRatioChange
}: {
  node: WorktreeLayoutNode
  path: WorktreeLayoutPath
  registerLeaf: (worktreeId: string, el: HTMLDivElement | null) => void
  onRatioChange: (path: WorktreeLayoutPath, ratio: number) => void
}): React.JSX.Element {
  if (node.type === 'leaf') {
    return (
      <div
        ref={(el) => registerLeaf(node.worktreeId, el)}
        data-worktree-slot={node.worktreeId}
        className="flex-1 min-w-0 min-h-0"
      />
    )
  }
  const ratio = clampWorktreeSplitRatio(node.ratio ?? 0.5)
  const isHorizontal = node.direction === 'horizontal'
  return (
    <div className={`flex ${isHorizontal ? 'flex-row' : 'flex-col'} flex-1 min-w-0 min-h-0`}>
      <div className="flex min-w-0 min-h-0 overflow-hidden" style={{ flex: `${ratio} 1 0%` }}>
        <SlotNode
          node={node.first}
          path={[...path, 'first']}
          registerLeaf={registerLeaf}
          onRatioChange={onRatioChange}
        />
      </div>
      <SplitResizeHandle
        direction={node.direction}
        onResizeStart={() => {}}
        onRatioChange={(nextRatio) => onRatioChange(path, nextRatio)}
      />
      <div className="flex min-w-0 min-h-0 overflow-hidden" style={{ flex: `${1 - ratio} 1 0%` }}>
        <SlotNode
          node={node.second}
          path={[...path, 'second']}
          registerLeaf={registerLeaf}
          onRatioChange={onRatioChange}
        />
      </div>
    </div>
  )
}

export function WorktreeSplitLayout({
  layout,
  onSlotRectsChange
}: {
  layout: WorktreeLayoutNode
  onSlotRectsChange: (rects: Map<string, WorktreePaneRect>) => void
}): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const leafElsRef = useRef<Map<string, HTMLDivElement>>(new Map())
  const lastRectsRef = useRef<Map<string, WorktreePaneRect>>(new Map())
  const observerRef = useRef<ResizeObserver | null>(null)
  const setActiveWorkbenchPaneRatio = useAppStore((s) => s.setActiveWorkbenchPaneRatio)

  const measure = useCallback(() => {
    const root = rootRef.current
    if (!root) {
      return
    }
    const rootRect = root.getBoundingClientRect()
    const rects = new Map<string, WorktreePaneRect>()
    for (const [id, el] of leafElsRef.current) {
      const r = el.getBoundingClientRect()
      rects.set(id, {
        top: r.top - rootRect.top,
        left: r.left - rootRect.left,
        width: r.width,
        height: r.height
      })
    }
    // Why: skip identical emissions so a parent that stores rects in state does
    // not loop (measure -> setState -> re-render -> measure).
    if (!rectsEqual(rects, lastRectsRef.current)) {
      lastRectsRef.current = rects
      onSlotRectsChange(rects)
    }
  }, [onSlotRectsChange])

  const registerLeaf = useCallback((worktreeId: string, el: HTMLDivElement | null) => {
    const map = leafElsRef.current
    const observer = observerRef.current
    const prev = map.get(worktreeId)
    if (prev && prev !== el) {
      observer?.unobserve(prev)
    }
    if (el) {
      map.set(worktreeId, el)
      observer?.observe(el)
    } else {
      map.delete(worktreeId)
    }
  }, [])

  useEffect(() => {
    const observer = new ResizeObserver(() => measure())
    observerRef.current = observer
    if (rootRef.current) {
      observer.observe(rootRef.current)
    }
    for (const el of leafElsRef.current.values()) {
      observer.observe(el)
    }
    measure()
    return () => {
      observer.disconnect()
      observerRef.current = null
    }
  }, [measure])

  // Re-measure whenever the layout tree changes (ratios, added/removed panes).
  useEffect(() => {
    measure()
  }, [layout, measure])

  const onRatioChange = useCallback(
    (path: WorktreeLayoutPath, ratio: number) => {
      setActiveWorkbenchPaneRatio(path, ratio)
    },
    [setActiveWorkbenchPaneRatio]
  )

  return (
    <div ref={rootRef} className="absolute inset-0 flex">
      <SlotNode node={layout} path={[]} registerLeaf={registerLeaf} onRatioChange={onRatioChange} />
    </div>
  )
}
