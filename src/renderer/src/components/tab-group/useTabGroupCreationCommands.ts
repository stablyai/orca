import { toast } from 'sonner'
import { useAppStore } from '../../store'
import { focusTerminalTabSurface } from '../../lib/focus-terminal-tab-surface'
import { createBrowserUuid } from '../../lib/browser-uuid'
import { createWebRuntimeSessionBrowserTab } from '../../runtime/web-runtime-browser-creation'
import { createWebRuntimeSessionTerminal } from '../../runtime/web-runtime-terminal-creation'
import { isWebRuntimeSessionActive } from '../../runtime/web-runtime-session-environment'
import { openTabBarEntry, type TabCreateEntryArgs } from '../tab-bar/tab-create-entry-action'
import { openMobileEmulatorTab } from '@/lib/open-mobile-emulator-tab'
import { ensureSimulatorTab, getSimulatorTabForWorktree } from '@/lib/ensure-simulator-tab'
import { buildDuplicatedBrowserTabOptions } from '@/lib/duplicate-browser-tab-options'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/worktree-runtime-owner'
import { browserWorkspaceHasRemoteOwner } from '@/runtime/remote-browser-tab-ownership'
import { getClientCreationActionPolicy } from '@/lib/client-creation-action-policy'
import type { TabGroupWorktreeSnapshot } from './useTabGroupItemProjections'

export function useTabGroupCreationCommands({
  groupId,
  worktreeId,
  worktreeState
}: {
  groupId: string
  worktreeId: string
  worktreeState: TabGroupWorktreeSnapshot
}) {
  const createTab = useAppStore((state) => state.createTab)
  const setActiveTab = useAppStore((state) => state.setActiveTab)
  const setActiveTabType = useAppStore((state) => state.setActiveTabType)
  const createBrowserTab = useAppStore((state) => state.createBrowserTab)
  const openNewBrowserTabInActiveWorkspace = useAppStore(
    (state) => state.openNewBrowserTabInActiveWorkspace
  )
  const openNewMarkdownInActiveWorkspace = useAppStore(
    (state) => state.openNewMarkdownInActiveWorkspace
  )
  const openNewTerminalTabInActiveWorkspace = useAppStore(
    (state) => state.openNewTerminalTabInActiveWorkspace
  )

  return {
    newBrowserTab: () => {
      void openNewBrowserTabInActiveWorkspace(groupId).catch((error) => {
        toast.error(error instanceof Error ? error.message : String(error))
      })
    },
    newSimulatorTab: worktreeState.mobileEmulatorEnabled
      ? () => {
          if (getSimulatorTabForWorktree(worktreeId)) {
            void ensureSimulatorTab(worktreeId, { surfacePane: true })
            return
          }
          void openMobileEmulatorTab(worktreeId, {
            placement: 'rightSplit',
            targetGroupId: groupId
          }).catch((error) => {
            toast.error(error instanceof Error ? error.message : String(error))
          })
        }
      : undefined,
    openEntry: async (args: TabCreateEntryArgs) => {
      await openTabBarEntry(args)
    },
    duplicateBrowserTab: (browserTabId: string, sourceUnifiedTabId: string) => {
      void (async () => {
        const state = useAppStore.getState()
        const tabs = state.browserTabsByWorktree[worktreeId] ?? []
        const source = tabs.find((t) => t.id === browserTabId)
        if (!source) {
          return
        }
        const runtimeEnvironmentId = runtimeEnvironmentIdOrLocalUnlessTwin(state, worktreeId)
        const browserAvailability = getClientCreationActionPolicy(state, worktreeId)[
          'managed-browser'
        ]
        if (browserAvailability.state !== 'enabled') {
          throw new Error(browserAvailability.reason)
        }
        if (
          browserAvailability.provider === 'paired-runtime' &&
          browserWorkspaceHasRemoteOwner(state, source.id, runtimeEnvironmentId)
        ) {
          const created = await createWebRuntimeSessionBrowserTab({
            worktreeId,
            environmentId: runtimeEnvironmentId,
            url: source.url,
            profileId: source.sessionProfileId,
            targetGroupId: groupId,
            clientAfterTabId: sourceUnifiedTabId
          })
          if (created) {
            return
          }
          throw new Error('The paired runtime could not duplicate the managed browser tab.')
        }
        // Why no targetGroupId: a source-following duplicate joins the source's live group.
        createBrowserTab(worktreeId, source.url, {
          ...buildDuplicatedBrowserTabOptions(source),
          ...(runtimeEnvironmentId ? { browserRuntimeEnvironmentId: null } : {}),
          afterTabId: sourceUnifiedTabId
        })
      })().catch((error) => {
        toast.error(error instanceof Error ? error.message : String(error))
      })
    },
    // Why: target the owning group explicitly; the "+" menu can fire from an unfocused panel without updating global group focus.
    newFileTab: async () => {
      await openNewMarkdownInActiveWorkspace(groupId)
    },
    newTerminalTab: () => {
      void openNewTerminalTabInActiveWorkspace(groupId)
    },
    newTerminalWithShell: (shellOverride: string) => {
      void (async () => {
        const environmentId = runtimeEnvironmentIdOrLocalUnlessTwin(
          useAppStore.getState(),
          worktreeId
        )
        const outcome = await createWebRuntimeSessionTerminal(
          {
            worktreeId,
            environmentId,
            targetGroupId: groupId,
            shell: shellOverride,
            activate: true
          },
          { userAct: true }
        )
        if (outcome.status === 'created' || isWebRuntimeSessionActive(environmentId)) {
          return
        }
        const tabId = createBrowserUuid()
        createTab(worktreeId, groupId, shellOverride, { id: tabId })
        setActiveTab(tabId)
        setActiveTabType('terminal', worktreeId)
        focusTerminalTabSurface(tabId)
      })()
    }
  }
}
