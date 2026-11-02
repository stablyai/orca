// The one execution host every tab-bar entry names (as the window stamps new tabs), derived from
// what owns the tab.

import {
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../execution-host'
import type { TabContentType } from '../tab-types'
import type { PersistedOpenFile } from '../workspace-session-state-types'
import { editorTabShowsFile } from './workspace-layout-editor-tab-file'

type FileOwner = Pick<
  PersistedOpenFile,
  'filePath' | 'externalSshTargetId' | 'runtimeEnvironmentId'
>

/** An editor tab follows its file's owner, as the window stamps it; every other tab its partition. */
export function tabExecutionHostId(
  tab: { kind: TabContentType; entityId: string },
  files: readonly FileOwner[] | undefined,
  hostId: ExecutionHostId,
  worktreeId: string
): ExecutionHostId {
  const file =
    tab.kind === 'editor'
      ? files?.find((entry) => editorTabShowsFile(tab.entityId, entry, worktreeId))
      : undefined
  if (file?.externalSshTargetId) {
    return toSshExecutionHostId(file.externalSshTargetId)
  }
  if (file?.runtimeEnvironmentId) {
    return toRuntimeExecutionHostId(file.runtimeEnvironmentId)
  }
  return hostId
}
