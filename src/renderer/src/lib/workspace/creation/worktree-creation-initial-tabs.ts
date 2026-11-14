import { useAppStore } from '@/store/index'
import type { ExecutionHostId } from '../../../../../shared/execution-host'
import type { WorktreeDefaultTabsLaunch } from '../../../../../shared/worktree/creation/launch-types'
import type { CreatedWorktreeResult } from '@/store/slices/worktrees/create/worktree-create-payload'
import type { WorktreeActivationOptions } from '../activation/worktree-activation-surface-selection'
import type { WorktreeCreationRequest } from './pending-worktree-creation'
import type { windowStartupAfterCreate } from './worktree-creation-host-agent-launch'
import { ensureWorktreeHasInitialTerminal } from '../activation/initial-surface/worktree-initial-terminal-seeding'
import { isInstantFolderWorktreeCreation } from './worktree-creation-surface'

export function prepareCreatedWorktreeActivation({
  creationId,
  request,
  result,
  windowStartup,
  defaultTabs,
  setupIsOnlySurface,
  executionHostId
}: {
  creationId: string
  request: WorktreeCreationRequest
  result: CreatedWorktreeResult
  windowStartup: ReturnType<typeof windowStartupAfterCreate>
  defaultTabs: WorktreeDefaultTabsLaunch | undefined
  setupIsOnlySurface: boolean
  executionHostId?: ExecutionHostId
}): { primaryTabId: string | null; options: WorktreeActivationOptions } {
  const onCreationHost = executionHostId ? { executionHostId } : {}
  let primaryTabId: string | null = null
  const instantFolder = isInstantFolderWorktreeCreation(useAppStore.getState(), request)
  if (instantFolder) {
    // Metadata is not a destination surface; build the selected ordinary tabs before navigation.
    primaryTabId = ensureWorktreeHasInitialTerminal(
      useAppStore.getState(),
      result.worktree.id,
      windowStartup.startup,
      result.setup,
      request.issueCommand,
      defaultTabs,
      {
        activateCreatedTabs: false,
        ...onCreationHost,
        ...windowStartup.terminalOptions,
        ...(request.agent !== null || setupIsOnlySurface ? { callerProvidesSurface: true } : {})
      }
    )
  }
  return {
    primaryTabId,
    options: {
      sidebarRevealBehavior: 'auto',
      ...onCreationHost,
      ...(windowStartup.agent !== null ? { agent: windowStartup.agent } : {}),
      ...(primaryTabId
        ? { worktreeCreationId: creationId, providesInitialSurface: true }
        : {
            // Seeding above owns setup delivery; passing it again opens a second Setup tab.
            ...(result.setup && !instantFolder ? { setup: result.setup } : {}),
            ...(defaultTabs ? { defaultTabs } : {}),
            ...(windowStartup.startup ? { startup: windowStartup.startup } : {}),
            ...(request.issueCommand ? { issueCommand: request.issueCommand } : {}),
            ...windowStartup.terminalOptions,
            ...(setupIsOnlySurface ? { providesInitialSurface: true } : {})
          })
    }
  }
}
