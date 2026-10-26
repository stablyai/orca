import { ownSourceKeys } from './structured-chat-tab-index'
import type { AgentStatusTransition } from '@/store/agent-status-observers'
import { getTerminalTabOwners } from '@/store/slices/terminal-tab-owner-index'
import { getCachedTerminalTabForWorktree } from '@/components/terminal-pane/terminal-tab-lookup'
import { parsePaneKey, parseLegacyNumericPaneKey } from '../../../shared/stable-pane-id'
import { haveSameTerminalRoutingInputs } from './terminal-agent-routing-inputs'
import { worktreeUsesRemoteConnection } from '@/store/terminals/terminal-workspace-routing'

function ownValue<T>(source: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(source, key) ? source[key] : undefined
}

export function affectedExitEvidenceTabs({
  previous,
  next,
  changedKeys,
  terminalFacts
}: AgentStatusTransition): ReadonlySet<string> {
  const affected = new Set<string>()
  const addPane = (key: string): void => {
    const id = parsePaneKey(key)?.tabId ?? parseLegacyNumericPaneKey(key)?.tabId
    if (id) {
      affected.add(id)
    }
  }
  for (const key of changedKeys) {
    addPane(key)
  }
  if (previous.tabsByWorktree !== next.tabsByWorktree) {
    const hints = terminalFacts.tabsByWorktree
    if (hints) {
      for (const id of hints) {
        affected.add(id)
      }
    } else {
      for (const workspace of new Set([
        ...ownSourceKeys(previous.tabsByWorktree),
        ...ownSourceKeys(next.tabsByWorktree)
      ])) {
        if (
          ownValue(previous.tabsByWorktree, workspace) === ownValue(next.tabsByWorktree, workspace)
        ) {
          continue
        }
        for (const tab of [
          ...(ownValue(previous.tabsByWorktree, workspace) ?? []),
          ...(ownValue(next.tabsByWorktree, workspace) ?? [])
        ]) {
          if (
            getCachedTerminalTabForWorktree(previous.tabsByWorktree, workspace, tab.id) !==
            getCachedTerminalTabForWorktree(next.tabsByWorktree, workspace, tab.id)
          ) {
            affected.add(tab.id)
          }
        }
      }
    }
  }
  const changedRecords = <T>(
    before: Readonly<Record<string, T>>,
    after: Readonly<Record<string, T>>,
    add: (key: string) => void,
    hints?: readonly string[]
  ): void => {
    if (before !== after) {
      for (const key of hints ?? new Set([...ownSourceKeys(before), ...ownSourceKeys(after)])) {
        if (ownValue(before, key) !== ownValue(after, key)) {
          add(key)
        }
      }
    }
  }
  const addTab = (key: string): void => {
    affected.add(key)
  }
  changedRecords(previous.terminalLayoutsByTabId, next.terminalLayoutsByTabId, addTab)
  changedRecords(previous.ptyIdsByTabId, next.ptyIdsByTabId, addTab)
  changedRecords(previous.retainedAgentsByPaneKey, next.retainedAgentsByPaneKey, addPane)
  changedRecords(
    previous.paneForegroundAgentByPaneKey,
    next.paneForegroundAgentByPaneKey,
    addPane,
    terminalFacts.paneForegroundAgentByPaneKey
  )
  if (terminalFacts.unifiedTabsByWorktree) {
    for (const id of terminalFacts.unifiedTabsByWorktree) {
      affected.add(id)
    }
  } else {
    changedRecords(previous.unifiedTabsByWorktree, next.unifiedTabsByWorktree, (workspace) => {
      const before = new Set(ownValue(previous.unifiedTabsByWorktree, workspace) ?? [])
      const after = new Set(ownValue(next.unifiedTabsByWorktree, workspace) ?? [])
      for (const item of new Set([...before, ...after])) {
        if (item.contentType === 'terminal' && before.has(item) !== after.has(item)) {
          affected.add(item.entityId)
        }
      }
    })
  }
  const addWorkspace = (workspace: string): void => {
    for (const tab of [
      ...(ownValue(previous.tabsByWorktree, workspace) ?? []),
      ...(ownValue(next.tabsByWorktree, workspace) ?? [])
    ]) {
      affected.add(tab.id)
    }
  }
  changedRecords(previous.layoutByWorktree, next.layoutByWorktree, addWorkspace)
  changedRecords(previous.groupsByWorktree, next.groupsByWorktree, addWorkspace)
  changedRecords(previous.activeGroupIdByWorktree, next.activeGroupIdByWorktree, addWorkspace)
  if (previous.settings?.tabAutoGenerateTitle !== next.settings?.tabAutoGenerateTitle) {
    for (const id of getTerminalTabOwners(next.tabsByWorktree).keys()) {
      affected.add(id)
    }
  }
  if (!haveSameTerminalRoutingInputs(previous, next)) {
    for (const workspace of ownSourceKeys(next.tabsByWorktree)) {
      if (
        worktreeUsesRemoteConnection(previous, workspace) !==
        worktreeUsesRemoteConnection(next, workspace)
      ) {
        for (const tab of ownValue(next.tabsByWorktree, workspace) ?? []) {
          affected.add(tab.id)
        }
      }
    }
  }
  return affected
}
