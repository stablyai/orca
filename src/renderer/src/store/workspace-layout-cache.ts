// The window's read-only copy of each workspace's layout, exactly as the runtime published it
// (design 3.3). Not wired to the store yet: the switch makes it a slice and derives today's fields
// from it.

import { stableJson } from '../../../shared/workspace-layout/workspace-layout-load-report'
import type { PublishedWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-published'
import type { WorkspaceLayoutChangeFrame } from '../../../shared/workspace-layout/workspace-layout-stream-frames'

export type WorkspaceLayoutCache = Readonly<Record<string, PublishedWorkspaceLayout>>

export const EMPTY_WORKSPACE_LAYOUT_CACHE: WorkspaceLayoutCache = {}

/**
 * The cache's only writer (design 3.3's `applyFromRuntime`): replaces from the runtime's frame;
 * nothing edits, merges or saves it. Returns the same cache when nothing changed.
 */
export function applyLayoutFrame(
  cache: WorkspaceLayoutCache,
  frame: WorkspaceLayoutChangeFrame
): WorkspaceLayoutCache {
  switch (frame.type) {
    case 'workspace':
      // The runtime publishes a workspace only when it changed.
      return { ...cache, [frame.key]: frame.layout }
    case 'removed': {
      if (!(frame.key in cache)) {
        return cache
      }
      const { [frame.key]: _removed, ...rest } = cache
      return rest
    }
    case 'snapshot': {
      // Keeps each equal entry, so a reconnect with unchanged data re-renders nothing.
      const next: Record<string, PublishedWorkspaceLayout> = {}
      let changed = false
      for (const { key, layout } of frame.workspaces) {
        const cached = cache[key]
        const keep = cached !== undefined && stableJson(cached) === stableJson(layout)
        next[key] = keep ? cached : layout
        changed ||= !keep
      }
      return changed || Object.keys(next).length !== Object.keys(cache).length ? next : cache
    }
  }
}
