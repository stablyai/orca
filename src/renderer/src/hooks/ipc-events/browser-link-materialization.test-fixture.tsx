import { buildDefaultSettings } from '../../../../shared/default-global-settings'
import { createRoot } from 'react-dom/client'
import { useAppStore } from '@/store'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmationDialogProvider } from '@/components/confirmation-dialog'
import { BrowserPagePane } from '@/components/browser-pane/assemble-chrome/browser-page-pane'
import { registerBrowserOverlaySlotViewport } from '@/components/browser-pane/host-guest/browser-page-viewport'
import { registerBrowserStateIpcBridge } from './browser-state-ipc-bridge'

const worktreeId = 'link-probe-folder'
const profilePartition = 'persist:link-probe-isolated'
const defaultPartition = 'persist:link-probe-default'
let sourceWorkspaceId = ''
let sourcePageId = ''
const mounted = new Map<string, ReturnType<typeof createRoot>>()

function mountTabs(): void {
  const state = useAppStore.getState()
  for (const tab of state.browserTabsByWorktree[worktreeId] ?? []) {
    if (mounted.has(tab.id) || tab.id === sourceWorkspaceId) {
      continue
    }
    const page = state.browserPagesByWorkspace[tab.id]?.[0]
    if (!page) {
      throw new Error('Created tab has no page')
    }
    const slot = document.createElement('div')
    slot.style.cssText = 'width:800px;height:500px;position:relative'
    document.body.appendChild(slot)
    registerBrowserOverlaySlotViewport(tab.id, slot)
    const root = createRoot(slot)
    mounted.set(tab.id, root)
    root.render(
      <TooltipProvider>
        <ConfirmationDialogProvider>
          <BrowserPagePane
            browserTab={page}
            workspaceId={tab.id}
            worktreeId={worktreeId}
            sessionProfileId={tab.sessionProfileId ?? null}
            sessionPartition={tab.sessionPartition ?? null}
            isActive={state.activeBrowserTabIdByWorktree[worktreeId] === tab.id}
            chromeShortcutScope="inactive"
            isAutomationVisible={false}
            isMobileDriven={false}
            isRemotelyViewed={false}
            inputLocked={false}
            onUpdatePageState={state.updateBrowserPageState}
            onSetUrl={state.setBrowserPageUrl}
          />
        </ConfirmationDialogProvider>
      </TooltipProvider>
    )
  }
}

export function installBrowserLinkMaterializationProbe() {
  const initial = useAppStore.getState()
  const settings =
    initial.settings ??
    buildDefaultSettings({
      workspaceDir: '',
      appFontFamily: 'sans-serif',
      editorAutoSaveDelayMs: 1000,
      primarySelectionMiddleClickPaste: false,
      primarySelectionDefaultedForLinux: false,
      terminalFontFamily: 'monospace',
      terminalInactivePaneOpacity: 1,
      terminalRightClickToPaste: false,
      notifications: {
        enabled: false,
        agentTaskComplete: false,
        terminalBell: false,
        suppressWhenFocused: true,
        customSoundId: 'system',
        customSoundPath: null,
        customSoundVolume: 0,
        mutedNotificationSourceIds: [],
        notifyHiddenWorkspaces: false
      },
      voice: {
        enabled: false,
        sttModel: '',
        modelsDir: '',
        language: 'en',
        dictationMode: 'hold',
        terminalConfirmBeforeInsert: true,
        userModels: [],
        openAiApiKeyConfigured: false,
        microphoneDeviceId: null,
        microphoneDeviceLabel: null
      }
    })
  useAppStore.setState({
    activeWorktreeId: worktreeId,
    settings: {
      ...settings,
      activeRuntimeEnvironmentId: null,
      browserDefaultProfileIdByHostId: { local: 'other-profile' }
    },
    browserSessionProfiles: [
      {
        id: 'isolated-profile',
        label: 'Isolated synthetic profile',
        partition: profilePartition,
        scope: 'isolated',
        source: null
      },
      {
        id: 'other-profile',
        label: 'Other synthetic profile',
        partition: defaultPartition,
        scope: 'isolated',
        source: null
      }
    ]
  })
  const source = useAppStore.getState().createBrowserTab(worktreeId, 'about:blank', {
    sessionProfileId: 'isolated-profile',
    sessionPartition: profilePartition,
    activate: true
  })
  sourceWorkspaceId = source.id
  if (!source.activePageId) {
    throw new Error('Source has no active page')
  }
  sourcePageId = source.activePageId
  registerBrowserStateIpcBridge([], () => false)
  return {
    sourcePageId,
    snapshot: () => {
      const state = useAppStore.getState()
      return {
        tabs: state.browserTabsByWorktree[worktreeId],
        pages: state.browserPagesByWorkspace,
        selected: state.activeBrowserTabIdByWorktree[worktreeId],
        selectedUnified: state.groupsByWorktree[worktreeId]?.map((group) => group.activeTabId),
        unified: state.unifiedTabsByWorktree[worktreeId],
        sourceWorkspaceId
      }
    },
    mountTabs,
    mutate: (transition: string) => {
      const state = useAppStore.getState()
      const tabs = state.browserTabsByWorktree[worktreeId] ?? []
      if (transition === 'remove-tab') {
        useAppStore.setState({
          browserTabsByWorktree: {
            [worktreeId]: tabs.filter((tab) => tab.id !== sourceWorkspaceId)
          }
        })
      }
      if (transition === 'remove-page') {
        useAppStore.setState({ browserPagesByWorkspace: {} })
      }
      if (transition === 'profile-switch') {
        useAppStore.setState({
          browserTabsByWorktree: {
            [worktreeId]: tabs.map((tab) =>
              tab.id === sourceWorkspaceId
                ? { ...tab, sessionProfileId: 'other-profile', sessionPartition: defaultPartition }
                : tab
            )
          }
        })
      }
      if (transition === 'delete-profile') {
        useAppStore.setState({ browserSessionProfiles: [] })
      }
    }
  }
}
