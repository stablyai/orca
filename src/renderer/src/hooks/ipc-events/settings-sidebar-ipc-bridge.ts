import { canShowRightSidebarForView } from '@/lib/right-sidebar-visibility'
import { showTerminalShortcutCaptureNotification } from '@/lib/terminal-shortcut-capture-notification'
import { TOGGLE_FLOATING_TERMINAL_EVENT } from '@/lib/floating-terminal'
import { subscribeToUnpairedDeviceAuthNotification } from '../unpaired-device-auth-notification'
import { translate } from '@/i18n/i18n'
import { toast } from 'sonner'
import { useAppStore } from '../../store'
import { openPluginInstallLink } from '../../store/plugin-preview-request'

function getShortcutPlatform(): NodeJS.Platform {
  if (navigator.userAgent.includes('Mac')) {
    return 'darwin'
  }
  if (navigator.userAgent.includes('Windows')) {
    return 'win32'
  }
  return 'linux'
}

let latestWorktreeDeepLinkSeq = 0
let cancelPendingWorktreeDeepLinkWait: (() => void) | null = null

function dispatchWorktreeDeepLinkWhenReposReady(
  link: Parameters<ReturnType<typeof useAppStore.getState>['openWorktreeDeepLink']>[0],
  unsubs: (() => void)[]
): void {
  const seq = ++latestWorktreeDeepLinkSeq
  cancelPendingWorktreeDeepLinkWait?.()
  cancelPendingWorktreeDeepLinkWait = null

  const initialState = useAppStore.getState()
  const currentRepos = initialState.repos ?? []
  if (!link.repo?.trim() || currentRepos.length > 0 || !initialState.awaitLocalRepoCatalogSettlement) {
    initialState.openWorktreeDeepLink(link)
    return
  }

  let cancelled = false
  let unsubscribeStore: (() => void) | null = null
  const cancelWait = () => {
    cancelled = true
    if (unsubscribeStore) {
      const unsub = unsubscribeStore
      unsubscribeStore = null
      unsub()
    }
  }
  cancelPendingWorktreeDeepLinkWait = cancelWait
  unsubs.push(cancelWait)

  const waitAndDispatch = () => {
    const settlePromise = useAppStore.getState().awaitLocalRepoCatalogSettlement?.()
    const dispatch = () => {
      if (!cancelled && seq === latestWorktreeDeepLinkSeq) {
        useAppStore.getState().openWorktreeDeepLink(link)
      }
    }
    if (settlePromise && typeof settlePromise.then === 'function') {
      void settlePromise.then(dispatch, dispatch)
    } else {
      dispatch()
    }
  }

  if ((initialState.reposFetchGeneration ?? 0) > 0) {
    waitAndDispatch()
    return
  }

  let started = false
  unsubscribeStore = useAppStore.subscribe((state) => {
    if (
      started ||
      cancelled ||
      seq !== latestWorktreeDeepLinkSeq ||
      ((state.reposFetchGeneration ?? 0) === 0 && (state.repos ?? []).length === 0)
    ) {
      return
    }
    started = true
    if (unsubscribeStore) {
      const unsub = unsubscribeStore
      unsubscribeStore = null
      unsub()
    }
    waitAndDispatch()
  })
}

export function registerSettingsAndSidebarIpcBridge(unsubs: (() => void)[]): void {
  unsubs.push(
    window.api.ui.onOpenSettings(() => {
      useAppStore.getState().openSettingsPage()
    })
  )

  const unsubscribeOpenSkillShare = window.api.ui.onOpenSkillShare?.((shareId) => {
    useAppStore.getState().openSkillShare(shareId)
  })
  if (unsubscribeOpenSkillShare) {
    unsubs.push(unsubscribeOpenSkillShare)
  }

  const unsubscribeOpenWorktreeDeepLink = window.api.ui.onOpenWorktreeDeepLink?.((link) => {
    dispatchWorktreeDeepLinkWhenReposReady(link, unsubs)
  })
  if (unsubscribeOpenWorktreeDeepLink) {
    unsubs.push(unsubscribeOpenWorktreeDeepLink)
  }

  // Why: a tray "Settings…" click can fire before this attaches; consume any queued intent (?. guards stale preload).
  void window.api.ui
    .consumePendingOpenSettings?.()
    .then((open) => {
      if (open) {
        useAppStore.getState().openSettingsPage()
      }
    })
    .catch(() => {})

  const pendingSkillShare = window.api.ui.consumePendingSkillShare?.()
  if (pendingSkillShare && typeof pendingSkillShare.then === 'function') {
    void pendingSkillShare
      .then((shareId) => {
        if (shareId) {
          useAppStore.getState().openSkillShare(shareId)
        }
      })
      .catch(() => {})
  }

  unsubs.push(window.api.ui.onOpenPluginInstallLink?.(openPluginInstallLink) ?? (() => {}))
  const pendingPluginLink = window.api.ui.consumePendingPluginInstallLink?.()
  if (pendingPluginLink && typeof pendingPluginLink.then === 'function') {
    void pendingPluginLink
      .then((link) => {
        if (link) {
          openPluginInstallLink(link)
        }
      })
      .catch(() => {})
  }

  const pendingWorktree = window.api.ui.consumePendingWorktreeDeepLink?.()
  if (pendingWorktree && typeof pendingWorktree.then === 'function') {
    void pendingWorktree
      .then((link) => {
        if (link) {
          dispatchWorktreeDeepLinkWhenReposReady(link, unsubs)
        }
      })
      .catch(() => {})
  }

  unsubs.push(
    window.api.ui.onOpenSetupGuide?.(() => {
      useAppStore.getState().openModal('setup-guide', { telemetrySource: 'help_menu' })
    }) ?? (() => {})
  )

  // Lost-registry auth loops need a visible remedy on either end; main throttles this notice once per session.
  unsubs.push(
    subscribeToUnpairedDeviceAuthNotification(window.api.mobile, () => {
      toast.warning(
        translate(
          'auto.hooks.useIpcEvents.ef223fbb6b',
          'A device tried to connect but is not paired'
        ),
        {
          id: 'unpaired-device-auth-failure',
          description: translate(
            'auto.hooks.useIpcEvents.11992d0337',
            'If this was your phone or another Orca client, re-pair it from Settings → Mobile.'
          ),
          // Why: main emits this recovery path once per session, so it must remain visible until acted on or dismissed.
          duration: Infinity,
          action: {
            label: translate('auto.hooks.useIpcEvents.6573cfe955', 'Open Mobile Settings'),
            onClick: () => {
              const store = useAppStore.getState()
              store.openSettingsTarget({ pane: 'mobile', repoId: null })
              store.openSettingsPage()
            }
          }
        }
      )
    })
  )

  unsubs.push(
    window.api.ui.onOpenFeatureTour(() => {
      useAppStore.getState().openModal('feature-wall', { source: 'help_menu' })
    })
  )

  // Why: View > Appearance toggles settings in main and broadcasts; merge into the store for an immediate re-render.
  unsubs.push(
    window.api.settings.onChanged((updates) => {
      const store = useAppStore.getState()
      if (!store.settings) {
        return
      }
      const { worktreeVisibilityDefaults, ...activeOwnerUpdates } = updates
      const settingsUpdates = store.settings.activeRuntimeEnvironmentId
        ? activeOwnerUpdates
        : updates
      useAppStore.setState({
        settings: {
          ...store.settings,
          ...settingsUpdates,
          notifications: {
            ...store.settings.notifications,
            ...updates.notifications
          }
        },
        ...(worktreeVisibilityDefaults
          ? {
              worktreeVisibilityDefaultsByHost: {
                ...store.worktreeVisibilityDefaultsByHost,
                local: worktreeVisibilityDefaults
              }
            }
          : {})
      })
      if ('worktreeVisibilityDefaults' in updates) {
        void store.fetchAllWorktrees({ visibilityOwnerHostId: 'local' })
      }
    })
  )

  // Why: UI view-state is shared with mobile via ui.set; re-hydrate so mobile changes reflect live in the desktop sidebar.
  unsubs.push(
    window.api.ui.onStateChanged((ui) => {
      useAppStore.getState().hydratePersistedUI(ui, 'sync')
    })
  )

  if (window.api.keybindings) {
    unsubs.push(
      window.api.keybindings.onChanged((snapshot) => {
        useAppStore.getState().setKeybindingSnapshot(snapshot)
      })
    )
  }

  unsubs.push(
    window.api.ui.onToggleLeftSidebar(() => {
      useAppStore.getState().toggleSidebar()
    })
  )

  unsubs.push(
    window.api.ui.onToggleRightSidebar(() => {
      const store = useAppStore.getState()
      if (!canShowRightSidebarForView(store.activeView)) {
        return
      }
      store.toggleRightSidebar()
    })
  )

  unsubs.push(
    window.api.ui.onToggleWorktreePalette(() => {
      const store = useAppStore.getState()
      if (store.activeModal === 'worktree-palette') {
        store.closeModal()
        return
      }
      store.openModal('worktree-palette')
    })
  )

  unsubs.push(
    window.api.ui.onToggleFloatingTerminal(() => {
      window.dispatchEvent(new CustomEvent(TOGGLE_FLOATING_TERMINAL_EVENT))
    })
  )

  if (window.api.ui.onTerminalShortcutCaptured) {
    unsubs.push(
      window.api.ui.onTerminalShortcutCaptured(({ actionId }) => {
        showTerminalShortcutCaptureNotification({
          actionId,
          platform: getShortcutPlatform(),
          keybindings: useAppStore.getState().keybindings
        })
      })
    )
  }
}
