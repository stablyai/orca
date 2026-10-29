import type { SessionMapField } from './session-change-set'
import { parseWorkspaceKey } from './workspace-scope'
export type SessionReferenceKind =
  | 'owner'
  | 'tab'
  | 'pane'
  | 'leaf'
  | 'pty'
  | 'file'
  | 'page'
  | 'browser'
  | 'repo'
  | 'scrollback'
export type SessionUnitAddress = { field: SessionMapField; key: string }
export function record(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the object check excludes primitives and arrays; members remain unknown.
    return value as Record<string, unknown>
  }
  return undefined
}

export function rawOwner(key: string): string {
  const unqualified = key.includes('|') ? key.slice(key.indexOf('|') + 1) : key
  const scope = parseWorkspaceKey(unqualified)
  return scope?.type === 'worktree' ? scope.worktreeId : unqualified
}
