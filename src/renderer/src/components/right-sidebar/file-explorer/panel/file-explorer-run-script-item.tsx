import { SquareTerminal } from 'lucide-react'
import { shallow } from 'zustand/shallow'
import { createNewTerminalTab } from '@/components/terminal/tab-lifecycle/terminal-tab-create'
import { ContextMenuItem } from '@/components/ui/context-menu'
import { useTranslate } from '@/i18n/use-translate'
import { CLIENT_PLATFORM } from '@/lib/workspace/creation/new-workspace'
import { resolveHostPlatform } from '@/runtime/hosts/platform/execution-host-facts'
import { getLocalProjectExecutionRuntimeContext } from '@/runtime/hosts/preflight/local-preflight-context'
import { useAppStore } from '@/store/index'
import {
  readRuntimeStatuses,
  type RuntimeStatuses
} from '@/store/slices/runtime-status/views/runtime-status-owner'
import { useAppStoreWithHostStatuses } from '@/store/slices/runtime-status/views/use-app-store-with-host-statuses'
import type { AppState } from '@/store/types'
import { lastVerifiedRuntimeStatus } from '../../../../../../shared/remote-runtime/host-status/runtime-host-status'
import { SESSION_TABS_CREATE_TERMINAL_SHELL_RUNTIME_CAPABILITY } from '../../../../../../shared/remote-runtime/protocol/session-tabs-runtime-capabilities'
import { parseExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import {
  getFileExplorerOperationExecutionHostId,
  getFileExplorerOperationOwnerFromState
} from '../navigation/file-explorer-operation-owner'
import type { TreeNode } from '../tree/file-explorer-types'
import { buildFileExplorerScriptLaunch } from './file-explorer-script-command'

function resolveScriptLaunch(
  state: AppState,
  statuses: RuntimeStatuses,
  worktreeId: string,
  node: TreeNode
) {
  const owner = node.operationOwner
  if (!owner || owner.kind === 'unresolved' || state.activeWorktreeId !== worktreeId) {
    return null
  }
  if (
    JSON.stringify(owner) !==
    JSON.stringify(getFileExplorerOperationOwnerFromState(state, worktreeId))
  ) {
    return null
  }
  const environmentId = owner.kind === 'runtime' ? owner.environmentId : null
  const fact = resolveHostPlatform(state, statuses, {
    host: parseExecutionHostId(getFileExplorerOperationExecutionHostId(owner)),
    nestedSshTargetId: null,
    sshOwnerEnvironmentId: environmentId,
    workspacePath: node.path,
    projectRuntime: () => getLocalProjectExecutionRuntimeContext(state, worktreeId)
  })
  if (fact.kind !== 'known') {
    return null
  }
  const runtimeStatus = environmentId
    ? lastVerifiedRuntimeStatus(statuses.get(environmentId))
    : null
  // Never type a PowerShell command on a route that cannot guarantee the shell override.
  if (
    fact.platform === 'win32' &&
    (fact.hostKind === 'ssh' ||
      (fact.hostKind === 'runtime' &&
        !runtimeStatus?.capabilities?.includes(
          SESSION_TABS_CREATE_TERMINAL_SHELL_RUNTIME_CAPABILITY
        )))
  ) {
    return null
  }
  const windowsHost =
    fact.hostKind === 'local'
      ? CLIENT_PLATFORM === 'win32'
      : fact.hostKind === 'runtime' && runtimeStatus?.hostPlatform === 'win32'
  const launch = buildFileExplorerScriptLaunch(node.path, fact.platform, windowsHost)
  return launch ? { ...launch, expectedRuntimeEnvironmentId: environmentId } : null
}

export function FileExplorerRunScriptItem({
  node,
  worktreeId
}: {
  node: TreeNode
  worktreeId: string
}) {
  const t = useTranslate()
  const launch = useAppStoreWithHostStatuses(
    (state, statuses) => resolveScriptLaunch(state, statuses, worktreeId, node),
    shallow
  )
  if (!launch) {
    return null
  }
  return (
    <ContextMenuItem
      onSelect={() => {
        const current = resolveScriptLaunch(
          useAppStore.getState(),
          readRuntimeStatuses(),
          worktreeId,
          node
        )
        if (current) {
          createNewTerminalTab(worktreeId, current.shell, current)
        }
      }}
    >
      <SquareTerminal />
      {t('fileExplorer.runInTerminal', 'Run in Terminal')}
    </ContextMenuItem>
  )
}
