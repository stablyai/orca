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

/** Editor tabs follow file ownership; all other tabs follow their partition. */
export function tabExecutionHostId(
  tab: { kind: TabContentType; entityId: string },
  workspace: {
    worktreeId: string
    tabs: readonly { entityId: string }[]
    editorFiles?: readonly FileOwner[]
  },
  hostId: ExecutionHostId
): ExecutionHostId {
  const file = tab.kind === 'editor' ? editorTabFile(workspace, tab.entityId) : undefined
  if (file?.externalSshTargetId) {
    return toSshExecutionHostId(file.externalSshTargetId)
  }
  if (file?.runtimeEnvironmentId) {
    return toRuntimeExecutionHostId(file.runtimeEnvironmentId)
  }
  return hostId
}
