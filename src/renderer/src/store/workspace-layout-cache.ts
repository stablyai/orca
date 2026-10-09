// The window's read-only copy of each workspace's layout, exactly as the runtime published it
// (design 3.3). `applyFromRuntime` is its only writer; nothing edits, merges or saves it.
// Not wired to the store yet: the switch makes it a slice and derives today's fields from it.

import type { PublishedWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-published'
import type { WorkspaceLayoutStreamFrame } from '../../../shared/workspace-layout/workspace-layout-stream-frames'

export type WorkspaceLayoutCache = Readonly<Record<string, PublishedWorkspaceLayout>>

export const EMPTY_WORKSPACE_LAYOUT_CACHE: WorkspaceLayoutCache = {}

/** Replaces one workspace's layout with the runtime's, or drops it for null. */
export function applyFromRuntime(
  cache: WorkspaceLayoutCache,
  key: string,
  layout: PublishedWorkspaceLayout | null
): WorkspaceLayoutCache {
  if (layout) {
    return cache[key] === layout ? cache : { ...cache, [key]: layout }
  }
  if (!(key in cache)) {
    return cache
  }
  const { [key]: _removed, ...rest } = cache
  return rest
}

/** What the cache takes from the stream: a snapshot replaces every workspace; nothing is merged. */
export type WorkspaceLayoutCacheFrame = Exclude<WorkspaceLayoutStreamFrame, { type: 'end' }>

export function applyLayoutFrame(
  cache: WorkspaceLayoutCache,
  frame: WorkspaceLayoutCacheFrame
): WorkspaceLayoutCache {
  switch (frame.type) {
    case 'workspace':
      return applyFromRuntime(cache, frame.key, frame.layout)
    case 'removed':
      return applyFromRuntime(cache, frame.key, null)
    case 'snapshot': {
      const present = new Set(frame.workspaces.map((entry) => entry.key))
      let next = cache
      for (const key of Object.keys(cache)) {
        if (!present.has(key)) {
          next = applyFromRuntime(next, key, null)
        }
      }
      for (const { key, layout } of frame.workspaces) {
        next = applyFromRuntime(next, key, layout)
      }
      return next
    }
  }
}
