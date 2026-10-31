import type { AppState } from './types'
import type { WorkspacePresentation } from '../../../shared/workspace-presentation'
import { bindingIndexes } from './workspace-source-state'

/** A raw spelling can address a view; writes still decompose into its actual source owners. */
export function normalizeWorkspaceViewKeys(
  raw: AppState,
  view: AppState,
  patch: Partial<AppState>
): Partial<AppState> {
  const normalizeViewKeys = <T>(
    requested: Record<string, T> | undefined,
    shown: Record<string, T>
  ) => {
    if (!requested || requested === shown) {
      return requested
    }
    let next = requested
    for (const id of Object.keys(requested)) {
      if (requested[id] === shown[id]) {
        continue
      }
      const key = bindingIndexes.get(view)?.get(id)
      const display = key ? raw.workspacePresentations?.[key]?.displayWorkspaceId : undefined
      if (display && display !== id) {
        if (next === requested) {
          next = { ...requested }
        }
        next[display] = requested[id]
        delete next[id]
      }
    }
    return next
  }
  return {
    ...patch,
    ...(patch.unifiedTabsByWorktree && {
      unifiedTabsByWorktree: normalizeViewKeys(
        patch.unifiedTabsByWorktree,
        view.unifiedTabsByWorktree
      )
    }),
    ...(patch.groupsByWorktree && {
      groupsByWorktree: normalizeViewKeys(patch.groupsByWorktree, view.groupsByWorktree)
    }),
    ...(patch.layoutByWorktree && {
      layoutByWorktree: normalizeViewKeys(patch.layoutByWorktree, view.layoutByWorktree)
    }),
    ...(patch.activeGroupIdByWorktree && {
      activeGroupIdByWorktree: normalizeViewKeys(
        patch.activeGroupIdByWorktree,
        view.activeGroupIdByWorktree
      )
    }),
    ...(patch.tabsByWorktree && {
      tabsByWorktree: normalizeViewKeys(patch.tabsByWorktree, view.tabsByWorktree)
    }),
    ...(patch.browserTabsByWorktree && {
      browserTabsByWorktree: normalizeViewKeys(
        patch.browserTabsByWorktree,
        view.browserTabsByWorktree
      )
    })
  }
}

export function workspaceViewRecordEdits(raw: AppState, view: AppState, patch: Partial<AppState>) {
  const next = { ...raw, ...patch }
  const affected = new Map<string, WorkspacePresentation>()
  const rawEdits = <T>(
    before: Record<string, T>,
    shown: Record<string, T>,
    requested: Record<string, T> | undefined
  ): Record<string, T> => {
    if (!requested || requested === shown) {
      return before
    }
    const result = { ...before }
    for (const id of new Set([...Object.keys(shown), ...Object.keys(requested)])) {
      if (requested[id] === shown[id]) {
        continue
      }
      const key = bindingIndexes.get(view)?.get(id)
      const document = key ? raw.workspacePresentations?.[key] : undefined
      if (document && key) {
        affected.set(key, document)
      } else if (Object.hasOwn(requested, id)) {
        result[id] = requested[id]
      } else {
        delete result[id]
      }
    }
    return result
  }
  next.unifiedTabsByWorktree = rawEdits(
    raw.unifiedTabsByWorktree,
    view.unifiedTabsByWorktree,
    patch.unifiedTabsByWorktree
  )
  next.groupsByWorktree = rawEdits(
    raw.groupsByWorktree,
    view.groupsByWorktree,
    patch.groupsByWorktree
  )
  next.layoutByWorktree = rawEdits(
    raw.layoutByWorktree,
    view.layoutByWorktree,
    patch.layoutByWorktree
  )
  next.activeGroupIdByWorktree = rawEdits(
    raw.activeGroupIdByWorktree,
    view.activeGroupIdByWorktree,
    patch.activeGroupIdByWorktree
  )
  next.tabsByWorktree = rawEdits(raw.tabsByWorktree, view.tabsByWorktree, patch.tabsByWorktree)
  next.browserTabsByWorktree = rawEdits(
    raw.browserTabsByWorktree,
    view.browserTabsByWorktree,
    patch.browserTabsByWorktree
  )
  if (affected.size) {
    if (next.unifiedTabsByWorktree === raw.unifiedTabsByWorktree) {
      next.unifiedTabsByWorktree = { ...raw.unifiedTabsByWorktree }
    }
    if (next.groupsByWorktree === raw.groupsByWorktree) {
      next.groupsByWorktree = { ...raw.groupsByWorktree }
    }
    if (next.layoutByWorktree === raw.layoutByWorktree) {
      next.layoutByWorktree = { ...raw.layoutByWorktree }
    }
    if (next.activeGroupIdByWorktree === raw.activeGroupIdByWorktree) {
      next.activeGroupIdByWorktree = { ...raw.activeGroupIdByWorktree }
    }
    if (next.tabsByWorktree === raw.tabsByWorktree) {
      next.tabsByWorktree = { ...raw.tabsByWorktree }
    }
    if (next.browserTabsByWorktree === raw.browserTabsByWorktree) {
      next.browserTabsByWorktree = { ...raw.browserTabsByWorktree }
    }
  }
  return { next, affected }
}
