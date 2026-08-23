import type { TerminalWindowTransferCommand } from '../../../../shared/terminal-window-transfer'
import type { AppState } from '../types'
import { buildTransferredTerminalRemovalPatch } from './terminal-window-transfer-removal-state'
import {
  recordValue,
  restoreTransferSelectors,
  type TransferRollbackPatch
} from './terminal-window-transfer-projection-rollback'
import { buildTransferredTerminalRemovalRollbackPatch } from './terminal-window-transfer-removal-rollback'
import { transferredTerminalWorktreeIds } from './terminal-window-transfer-worktree-scope'

function buildImportRollback(
  before: AppState,
  after: AppState,
  current: AppState,
  command: TerminalWindowTransferCommand
): Partial<AppState> {
  const changed = (Object.keys(after) as (keyof AppState)[]).some(
    (field) => !Object.is(before[field], after[field])
  )
  if (!changed) {
    return {}
  }
  const afterRemoval = buildTransferredTerminalRemovalPatch(after, command.tabId)
  const currentRemoval = buildTransferredTerminalRemovalPatch(current, command.tabId)
  if (!afterRemoval.ok || !currentRemoval.ok) {
    return {}
  }
  const removedAfter = { ...after, ...afterRemoval.patch }
  const removedCurrent = { ...current, ...currentRemoval.patch }
  const restored = buildTransferredTerminalRemovalRollbackPatch(
    before,
    removedAfter,
    removedCurrent,
    command.tabId,
    current
  )
  const patch = { ...currentRemoval.patch, ...restored } as TransferRollbackPatch
  const worktreeIds = transferredTerminalWorktreeIds(after, command.tabId)
  for (const field of [
    'tabsByWorktree',
    'unifiedTabsByWorktree',
    'groupsByWorktree',
    'tabBarOrderByWorktree'
  ] as const) {
    const beforeRecord = recordValue(before, field)
    const projected = (patch[field] ?? recordValue(current, field)) as TransferRollbackPatch
    let next = projected
    for (const worktreeId of worktreeIds) {
      if (Object.hasOwn(beforeRecord, worktreeId)) {
        continue
      }
      const value = projected[worktreeId]
      if (!Array.isArray(value) || value.length > 0) {
        continue
      }
      if (next === projected) {
        next = { ...projected }
      }
      delete next[worktreeId]
    }
    if (next !== projected) {
      patch[field] = next
    }
  }
  restoreTransferSelectors(patch, before, after, current, worktreeIds)
  const repoId = command.seed?.repo?.id
  if (repoId && !before.repos.some(({ id }) => id === repoId)) {
    const imported = after.repos.find(({ id }) => id === repoId)
    if (imported && current.repos.find(({ id }) => id === repoId) === imported) {
      patch.repos = current.repos.filter((repo) => repo !== imported)
    }
  }
  return patch as Partial<AppState>
}

export function buildTerminalWindowTransferFailureRollbackPatch(
  before: AppState,
  after: AppState,
  current: AppState,
  command: TerminalWindowTransferCommand
): Partial<AppState> {
  return command.phase === 'target-import' || command.phase === 'source-restore'
    ? buildImportRollback(before, after, current, command)
    : buildTransferredTerminalRemovalRollbackPatch(before, after, current, command.tabId)
}
