import { useCallback } from 'react'
import { toast } from 'sonner'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { useAppStore } from '../../store'
import { focusTerminalTabSurface } from '../../lib/focus-terminal-tab-surface'
import {
  createWebRuntimeSessionBrowserTab,
  createWebRuntimeSessionTerminal,
  isWebRuntimeSessionActive
} from '../../runtime/web-runtime-session'
import { openTabBarEntry, type TabCreateEntryArgs } from '../tab-bar/tab-create-entry-action'
import { openMobileEmulatorTab } from '@/lib/open-mobile-emulator-tab'
import { ensureSimulatorTab, getSimulatorTabForWorktree } from '@/lib/ensure-simulator-tab'
import { buildDuplicatedBrowserTabOptions } from '@/lib/duplicate-browser-tab-options'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { browserWorkspaceHasRemoteOwner } from '@/runtime/remote-browser-tab-ownership'
import { getClientCreationActionPolicy } from '@/lib/client-creation-action-policy'
import type { TabGroupWorktreeSnapshot } from './useTabGroupItemProjections'

export function recordTerminalTabGroupSplit(createdTerminal: TerminalTab | null | undefined): void {
  if (!createdTerminal) {
    return
  }
  useAppStore.getState().recordFeatureInteraction('terminal-pane-split')
}

export function useTabGroupCreationCommands({
  groupId,
  worktreeId,
  worktreeState
}: {
  groupId: string
  worktreeId: string
  worktreeState: TabGroupWorktreeSnapshot
}) {
  const focusGroup = useAppStore((state) => state.focusGroup)
  const createTab = useAppStore((state) => state.createTab)
  const setActiveTab = useAppStore((state) => state.setActiveTab)
  const setActiveTabType = useAppStore((state) => state.setActiveTabType)
  const createBrowserTab = useAppStore((state) => state.createBrowserTab)
  const createEmptySplitGroup = useAppStore((state) => state.createEmptySplitGroup)
  const openNewBrowserTabInActiveWorkspace = useAppStore(
    (state) => state.openNewBrowserTabInActiveWorkspace
  )
  const openNewMarkdownInActiveWorkspace = useAppStore(
    (state) => state.openNewMarkdownInActiveWorkspace
  )
  const openNewTerminalTabInActiveWorkspace = useAppStore(
    (state) => state.openNewTerminalTabInActiveWorkspace
  )

  const createSplitGroup = useCallback(
    (direction: 'left' | 'right' | 'up' | 'down') => {
      focusGroup(worktreeId, groupId)
      const newGroupId = createEmptySplitGroup(worktreeId, groupId, direction)
      if (!newGroupId) {
        return
      }
      // Why: this Split entry point always seeds a fresh terminal (tab-drag can open other directions).
      const terminal = createTab(worktreeId, newGroupId)
      recordTerminalTabGroupSplit(terminal)
      setActiveTab(terminal.id)
      setActiveTabType('terminal')
    },
    [
      createEmptySplitGroup,
      createTab,
      focusGroup,
      groupId,
      setActiveTab,
      setActiveTabType,
      worktreeId
    ]
  )

  // Why: these stay unmemoized plain lambdas — the original built them inline in the returned commands object.
  return {
    createSplitGroup,
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
          // Why: mobile simulators are most useful beside the current tab group.
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
    duplicateBrowserTab: (browserTabId: string) => {
      void (async () => {
        const state = useAppStore.getState()
        const tabs = state.browserTabsByWorktree[worktreeId] ?? []
        const source = tabs.find((t) => t.id === browserTabId)
        if (!source) {
          return
        }
        const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(state, worktreeId)
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
            targetGroupId: groupId
          })
          if (created) {
            return
          }
          throw new Error('The paired runtime could not duplicate the managed browser tab.')
        }
        createBrowserTab(worktreeId, source.url, {
          ...buildDuplicatedBrowserTabOptions(source),
          ...(runtimeEnvironmentId ? { browserRuntimeEnvironmentId: null } : {}),
          targetGroupId: groupId
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
        const environmentId = getRuntimeEnvironmentIdForWorktree(useAppStore.getState(), worktreeId)
        const outcome = await createWebRuntimeSessionTerminal({
          worktreeId,
          environmentId,
          targetGroupId: groupId,
          command: shellOverride,
          activate: true
        })
        if (outcome.status === 'created' || isWebRuntimeSessionActive(environmentId)) {
          return
        }
        const terminal = createTab(worktreeId, groupId, shellOverride)
        setActiveTab(terminal.id)
        setActiveTabType('terminal')
        focusTerminalTabSurface(terminal.id)
      })()
    }
  }
}
