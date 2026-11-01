import { terminalHostAliasMatchesTab, type TerminalHostAlias } from '../terminal-host-alias'
import {
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../execution-host'
import type { TabContentType } from '../tab-types'
import type { PersistedOpenFile } from '../workspace-session-state-types'
import { editorTabFile } from './workspace-layout-editor-tab-file'

type FileOwner = Pick<
  PersistedOpenFile,
  'filePath' | 'externalSshTargetId' | 'runtimeEnvironmentId'
>

/** Editor files and terminal aliases keep content ownership; ordinary tabs follow their partition. */
export function tabExecutionHostId(
  tab: {
    kind: TabContentType
    entityId: string
    terminal?: { hostTerminalAlias?: TerminalHostAlias }
  },
  workspace: {
    worktreeId: string
    tabs: readonly { entityId: string }[]
    editorFiles?: readonly FileOwner[]
  },
  hostId: ExecutionHostId
): ExecutionHostId {
  const alias = tab.kind === 'terminal' ? tab.terminal?.hostTerminalAlias : undefined
  if (alias && terminalHostAliasMatchesTab(alias, tab.entityId)) {
    return alias.executionHostId
  }
  const file = tab.kind === 'editor' ? editorTabFile(workspace, tab.entityId) : undefined
  if (file?.externalSshTargetId) {
    return toSshExecutionHostId(file.externalSshTargetId)
  }
  if (file?.runtimeEnvironmentId) {
    return toRuntimeExecutionHostId(file.runtimeEnvironmentId)
  }
  return hostId
}
