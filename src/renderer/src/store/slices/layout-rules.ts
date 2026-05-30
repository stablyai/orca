// Layout-rules persistence + runtime name→UUID mapping.

import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { LayoutConfig } from '../../../../shared/orca-yaml-layout'

// Why: a same-shape config push (e.g. boot prefetch arriving right
// after rebuildLayoutBindingsFromGroups) must NOT wipe freshly
// rebuilt bindings — that breaks post-restart `--group` lookup.
function shouldInvalidateLayoutBindings(
  prev: LayoutConfig | undefined,
  next: LayoutConfig | null
): boolean {
  if (!prev) {
    return false
  }
  if (!next) {
    return true
  }
  const prevGroups = prev.groups ?? {}
  const nextGroups = next.groups ?? {}
  const prevNames = Object.keys(prevGroups)
  const nextNames = Object.keys(nextGroups)
  if (prevNames.length !== nextNames.length) {
    return true
  }
  for (const name of prevNames) {
    const a = prevGroups[name]
    const b = nextGroups[name]
    if (!b || a?.kind !== b.kind) {
      return true
    }
  }
  return false
}

export type LayoutRulesSlice = {
  /** Parsed `layout` block from each worktree's orca.yaml. Set by main
   *  process at worktree activation (IPC `ui:layoutConfig` or hydrated
   *  from session). Undefined for worktrees without orca.yaml or with
   *  malformed config. */
  layoutConfigByWorktree: Record<string, LayoutConfig | undefined>

  /** Runtime mapping populated during `seedWorktreeLayout`: declared
   *  group name → live `TabGroup.id`. Distinct from layout config so
   *  rules can resolve names to UUIDs at create time without searching
   *  groupsByWorktree by label. */
  layoutGroupIdByName: Record<string, Record<string, string> | undefined>

  setLayoutConfigForWorktree: (worktreeId: string, config: LayoutConfig | null) => void
  recordLayoutGroupBinding: (worktreeId: string, groupName: string, groupId: string) => void
  /** Layout-rules — rebuild bindings from persisted `TabGroup.layoutGroupName`
   *  fields after session hydration. Called once at app start; idempotent. */
  rebuildLayoutBindingsFromGroups: (
    worktreeId: string,
    groups: readonly { id: string; layoutGroupName?: string }[]
  ) => void
}

export const createLayoutRulesSlice: StateCreator<AppState, [], [], LayoutRulesSlice> = (set) => ({
  layoutConfigByWorktree: {},
  layoutGroupIdByName: {},

  setLayoutConfigForWorktree: (worktreeId, config) =>
    set((s) => {
      const prev = s.layoutConfigByWorktree[worktreeId]
      const nextConfig = { ...s.layoutConfigByWorktree }
      if (config) {
        nextConfig[worktreeId] = config
      } else {
        delete nextConfig[worktreeId]
      }
      if (!shouldInvalidateLayoutBindings(prev, config)) {
        return { layoutConfigByWorktree: nextConfig }
      }
      const nextBindings = { ...s.layoutGroupIdByName }
      delete nextBindings[worktreeId]
      const groups = s.groupsByWorktree[worktreeId] ?? []
      // Why: split-derived siblings carry only kind (no layoutGroupName);
      // both must be in the cleanup or orphan locks survive a config drop.
      const stamped = groups.some((g) => g.layoutGroupName !== undefined || g.kind !== undefined)
      const update: Partial<AppState> = {
        layoutConfigByWorktree: nextConfig,
        layoutGroupIdByName: nextBindings
      }
      if (stamped) {
        update.groupsByWorktree = {
          ...s.groupsByWorktree,
          // Why: drop both stamps — name and kind — when shape changes;
          // they were derived from the prior config and survive only as
          // long as that config does.
          [worktreeId]: groups.map(({ layoutGroupName: _name, kind: _kind, ...rest }) => rest)
        }
      }
      return update
    }),

  recordLayoutGroupBinding: (worktreeId, groupName, groupId) =>
    set((s) => {
      const existing = s.layoutGroupIdByName[worktreeId] ?? {}
      // Why: stamp name (rebind on hydration) AND kind (split-derived
      // siblings inherit lock without sharing the YAML name).
      const declaredKind = s.layoutConfigByWorktree[worktreeId]?.groups?.[groupName]?.kind
      const groups = s.groupsByWorktree[worktreeId] ?? []
      const matchIndex = groups.findIndex((g) => g.id === groupId)
      const baseUpdate = {
        layoutGroupIdByName: {
          ...s.layoutGroupIdByName,
          [worktreeId]: { ...existing, [groupName]: groupId }
        }
      }
      if (matchIndex < 0) {
        return baseUpdate
      }
      const updatedGroups = [...groups]
      // Why: drop existing kind first so spread doesn't preserve a
      // stale value when the user removes `kind:` from yaml.
      const { kind: _drop, ...rest } = groups[matchIndex]
      updatedGroups[matchIndex] = {
        ...rest,
        layoutGroupName: groupName,
        ...(declaredKind ? { kind: declaredKind } : {})
      }
      return {
        ...baseUpdate,
        groupsByWorktree: { ...s.groupsByWorktree, [worktreeId]: updatedGroups }
      }
    }),

  rebuildLayoutBindingsFromGroups: (worktreeId, groups) =>
    set((s) => {
      const map: Record<string, string> = {}
      for (const g of groups) {
        if (g.layoutGroupName) {
          map[g.layoutGroupName] = g.id
        }
      }
      // Why: ALWAYS overwrite the worktree's bindings (or clear them).
      // Returning early on an empty map would leave a stale binding
      // surviving a stamp-clear flow, defeating the rebuild.
      const next = { ...s.layoutGroupIdByName }
      if (Object.keys(map).length === 0) {
        if (!(worktreeId in next)) {
          return s
        }
        delete next[worktreeId]
      } else {
        next[worktreeId] = map
      }
      return { layoutGroupIdByName: next }
    })
})
