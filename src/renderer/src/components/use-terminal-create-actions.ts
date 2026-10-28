import { useCallback } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '../store'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { createWebRuntimeSessionBrowserTab } from '@/runtime/web-runtime-browser-creation'
import { createWebRuntimeSessionTerminal } from '@/runtime/web-runtime-terminal-creation'
import { isWebRuntimeSessionActive } from '@/runtime/web-runtime-session-environment'
import { openMobileEmulatorTab } from '@/lib/open-mobile-emulator-tab'
import { persistAgentLaunchTabOrder } from '@/lib/launch-agent-tab-order'
import { buildDuplicatedBrowserTabOptions } from '@/lib/duplicate-browser-tab-options'
import { browserWorkspaceHasRemoteOwner } from '@/runtime/remote-browser-tab-ownership'
import { getClientCreationActionPolicy } from '@/lib/client-creation-action-policy'
import { showClientCreationActionError } from '@/lib/client-creation-action-error'
import { openTabBarEntry, type TabCreateEntryArgs } from './tab-bar/tab-create-entry-action'
import { translate } from '@/i18n/i18n'
import { getActiveWorktreeRuntimeEnvironmentId } from './terminal-workspace-model'
import type { TerminalColdActivationController } from './terminal-cold-activation'

export function useTerminalCreateActions(controller: TerminalColdActivationController) {
  const {
    activeWorktreeId,
    createBrowserTab,
    createTab,
    openNewBrowserTabInActiveWorkspace,
    openNewMarkdownInActiveWorkspace,
    openNewTerminalTabInActiveWorkspace,
    setActiveTabType
  } = controller
  const handleNewTab = useCallback(
    (shellOverride?: string) => {
      if (!activeWorktreeId) {
        return
      }
      const targetGroupId =
        useAppStore.getState().activeGroupIdByWorktree[activeWorktreeId] ??
        useAppStore.getState().groupsByWorktree[activeWorktreeId]?.[0]?.id
      const runtimeEnvironmentId = getActiveWorktreeRuntimeEnvironmentId(activeWorktreeId)
      if (isWebRuntimeSessionActive(runtimeEnvironmentId)) {
        void createWebRuntimeSessionTerminal({
          worktreeId: activeWorktreeId,
          environmentId: runtimeEnvironmentId,
          targetGroupId,
          shell: shellOverride,
          activate: true
        })
        return
      }
      if (!shellOverride && targetGroupId) {
        void openNewTerminalTabInActiveWorkspace(targetGroupId)
        return
      }
      const tabId = createBrowserUuid()
      createTab(activeWorktreeId, undefined, shellOverride, { id: tabId })
      setActiveTabType('terminal', activeWorktreeId)
      persistAgentLaunchTabOrder(activeWorktreeId, tabId)
      focusTerminalTabSurface(tabId)
    },
    [activeWorktreeId, createTab, openNewTerminalTabInActiveWorkspace, setActiveTabType]
  )

  const handleNewSimulatorTab = useCallback(() => {
    if (!activeWorktreeId) {
      return
    }
    const targetGroupId =
      useAppStore.getState().activeGroupIdByWorktree[activeWorktreeId] ??
      useAppStore.getState().groupsByWorktree[activeWorktreeId]?.[0]?.id
    void openMobileEmulatorTab(activeWorktreeId, {
      placement: 'rightSplit',
      targetGroupId: targetGroupId ?? undefined
    }).catch(showClientCreationActionError)
  }, [activeWorktreeId])

  const handleNewBrowserTab = useCallback(() => {
    if (!activeWorktreeId) {
      return
    }
    const targetGroupId =
      useAppStore.getState().activeGroupIdByWorktree[activeWorktreeId] ??
      useAppStore.getState().groupsByWorktree[activeWorktreeId]?.[0]?.id
    if (targetGroupId) {
      void openNewBrowserTabInActiveWorkspace(targetGroupId).catch(showClientCreationActionError)
      return
    }
    const state = useAppStore.getState()
    const browserAvailability = getClientCreationActionPolicy(state, activeWorktreeId)[
      'managed-browser'
    ]
    if (browserAvailability.state !== 'enabled') {
      toast.error(browserAvailability.reason)
      return
    }
    const defaultUrl = state.browserDefaultUrl ?? 'about:blank'
    const runtimeEnvironmentId = getActiveWorktreeRuntimeEnvironmentId(activeWorktreeId)
    if (browserAvailability.provider === 'paired-runtime' && runtimeEnvironmentId) {
      void createWebRuntimeSessionBrowserTab({
        worktreeId: activeWorktreeId,
        environmentId: runtimeEnvironmentId,
        url: defaultUrl
      }).catch(showClientCreationActionError)
      return
    }
    createBrowserTab(activeWorktreeId, defaultUrl, {
      title: translate('auto.components.Terminal.37da0d736f', 'New Browser Tab'),
      focusAddressBar: true,
      ...(runtimeEnvironmentId ? { browserRuntimeEnvironmentId: null } : {})
    })
  }, [activeWorktreeId, createBrowserTab, openNewBrowserTabInActiveWorkspace])

  const handleOpenEntry = useCallback(async (args: TabCreateEntryArgs) => {
    await openTabBarEntry(args)
  }, [])

  const handleDuplicateBrowserTab = useCallback(
    (browserTabId: string, sourceUnifiedTabId: string) => {
      if (!activeWorktreeId) {
        return
      }
      const state = useAppStore.getState()
      const tabs = state.browserTabsByWorktree[activeWorktreeId] ?? []
      const source = tabs.find((tab) => tab.id === browserTabId)
      if (!source) {
        return
      }
      const runtimeEnvironmentId = getActiveWorktreeRuntimeEnvironmentId(activeWorktreeId)
      const browserAvailability = getClientCreationActionPolicy(state, activeWorktreeId)[
        'managed-browser'
      ]
      if (browserAvailability.state !== 'enabled') {
        toast.error(browserAvailability.reason)
        return
      }
      if (
        browserAvailability.provider === 'paired-runtime' &&
        runtimeEnvironmentId &&
        browserWorkspaceHasRemoteOwner(state, source.id, runtimeEnvironmentId)
      ) {
        void createWebRuntimeSessionBrowserTab({
          worktreeId: activeWorktreeId,
          environmentId: runtimeEnvironmentId,
          url: source.url,
          profileId: source.sessionProfileId,
          clientAfterTabId: sourceUnifiedTabId
        }).catch(showClientCreationActionError)
        return
      }
      try {
        createBrowserTab(activeWorktreeId, source.url, {
          ...buildDuplicatedBrowserTabOptions(source),
          ...(runtimeEnvironmentId ? { browserRuntimeEnvironmentId: null } : {}),
          afterTabId: sourceUnifiedTabId
        })
      } catch (error) {
        showClientCreationActionError(error)
      }
    },
    [activeWorktreeId, createBrowserTab]
  )

  const handleNewFile = useCallback(async () => {
    if (!activeWorktreeId) {
      return
    }
    const targetGroupId =
      useAppStore.getState().activeGroupIdByWorktree[activeWorktreeId] ??
      useAppStore.getState().groupsByWorktree[activeWorktreeId]?.[0]?.id
    if (!targetGroupId) {
      return
    }
    await openNewMarkdownInActiveWorkspace(targetGroupId)
  }, [activeWorktreeId, openNewMarkdownInActiveWorkspace])

  return {
    handleNewTab,
    handleNewSimulatorTab,
    handleNewBrowserTab,
    handleOpenEntry,
    handleDuplicateBrowserTab,
    handleNewFile
  }
}

export type TerminalCreateController = TerminalColdActivationController &
  ReturnType<typeof useTerminalCreateActions>
