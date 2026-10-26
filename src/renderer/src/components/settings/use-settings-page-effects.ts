import { useEffect } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '../../store'
import { keybindingMatchesAction } from '../../../../shared/keybindings'
import { resolveAppearanceAccordionDeepLink } from './appearance-usage-percentage-search'
import { registerWindowCloseGuard } from '../window-close-request-coordinator'
import { isIntentionalAppRestartInProgress } from '@/lib/updater-beforeunload'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { hasVisibleOverlay } from '@/lib/visible-overlay'
import { translate } from '@/i18n/i18n'
import {
  getSettingsTargetHostSelection,
  resolveSettingsTargetRepoId
} from './settings-project-list'
import type { SettingsStoreModel } from './use-settings-store-model'
import type { SettingsInteractionController } from './use-settings-interaction-controller'
import {
  getSettingsSectionId,
  SHORTCUTS_ESCAPE_CONFIRM_TOAST_ID,
  SHORTCUTS_ESCAPE_CONFIRM_WINDOW_MS
} from './settings-navigation-foundations'

export function useSettingsPageEffects(
  model: SettingsStoreModel,
  interactions: SettingsInteractionController
): void {
  const {
    activeSectionId,
    clearSettingsTarget,
    fetchKeybindings,
    fetchSettings,
    keybindings,
    refreshModelStates,
    repoIdToHostSelection,
    repoIdToRepresentative,
    setHighlightedSettingsTargetId,
    setMountedSectionIds,
    setQuickCommandAddIntentSignal,
    setRemoteServerAddIntentSignal,
    setSettingsHostChoice,
    setSettingsProjectHostSelection,
    setSshHostAddIntentSignal,
    setPendingNavRequestTick,
    setVoiceModelStatesLoading,
    settings,
    settingsNavigationTarget,
    settingsProjectList,
    showDesktopOnlySettings
  } = model
  const {
    closeSettingsPageWithPromptGuard,
    hasUnsavedSourceControlAiPromptChangesRef,
    pendingNavSectionRef,
    pendingScrollTargetRef,
    promptDiscardSourceControlAiPromptChanges,
    searchInputRef,
    shortcutsEscapeConfirmUntilRef
  } = interactions

  useEffect(() => {
    fetchSettings()
    fetchKeybindings()
  }, [fetchKeybindings, fetchSettings])

  useEffect(() => {
    if (!showDesktopOnlySettings) {
      setVoiceModelStatesLoading(false)
      return
    }
    let canceled = false
    // An empty pre-scan state does not mean speech models are missing.
    setVoiceModelStatesLoading(true)
    void refreshModelStates().finally(() => {
      if (!canceled) {
        setVoiceModelStatesLoading(false)
      }
    })
    return () => {
      canceled = true
    }
  }, [refreshModelStates, setVoiceModelStatesLoading, showDesktopOnlySettings])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) {
        return
      }
      // Nested overlays own Escape before page navigation.
      if (hasVisibleOverlay()) {
        return
      }
      // IME composition owns Escape; ordinary controls may close Settings.
      if (event.isComposing) {
        return
      }
      if (activeSectionId === 'shortcuts') {
        event.preventDefault()
        const now = Date.now()
        if (now <= shortcutsEscapeConfirmUntilRef.current) {
          shortcutsEscapeConfirmUntilRef.current = 0
          toast.dismiss(SHORTCUTS_ESCAPE_CONFIRM_TOAST_ID)
          void closeSettingsPageWithPromptGuard()
          return
        }
        shortcutsEscapeConfirmUntilRef.current = now + SHORTCUTS_ESCAPE_CONFIRM_WINDOW_MS
        toast.info(
          translate(
            'auto.components.settings.Settings.acc7bbdefd',
            'Press ESC again to exit settings'
          ),
          {
            id: SHORTCUTS_ESCAPE_CONFIRM_TOAST_ID,
            duration: SHORTCUTS_ESCAPE_CONFIRM_WINDOW_MS,
            className: 'whitespace-nowrap'
          }
        )
        return
      }
      void closeSettingsPageWithPromptGuard()
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [activeSectionId, closeSettingsPageWithPromptGuard, shortcutsEscapeConfirmUntilRef])

  // Use the discard dialog for close/quit; a bare unload veto offers no way to resolve dirty state.
  useEffect(() => {
    return registerWindowCloseGuard(() => {
      if (isIntentionalAppRestartInProgress()) {
        return true
      }
      if (!hasUnsavedSourceControlAiPromptChangesRef.current) {
        return true
      }
      return promptDiscardSourceControlAiPromptChanges()
    })
  }, [hasUnsavedSourceControlAiPromptChangesRef, promptDiscardSourceControlAiPromptChanges])

  useEffect(() => {
    const handleFindShortcut = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) {
        return
      }
      if (!keybindingMatchesAction('settings.search', event, getShortcutPlatform(), keybindings)) {
        return
      }
      const input = searchInputRef.current
      if (!input) {
        return
      }
      event.preventDefault()
      input.focus()
      input.select()
    }

    document.addEventListener('keydown', handleFindShortcut)
    return () => document.removeEventListener('keydown', handleFindShortcut)
  }, [keybindings, searchInputRef])

  useEffect(() => {
    if (!settings || !settingsNavigationTarget) {
      return
    }

    const paneSectionId = getSettingsSectionId(
      settingsNavigationTarget.pane,
      settingsNavigationTarget.repoId,
      repoIdToRepresentative
    )
    // Select the repo’s host before scrolling so host-specific anchors exist.
    const targetRepoId = resolveSettingsTargetRepoId(
      settingsNavigationTarget,
      repoIdToHostSelection.keys()
    )
    if (targetRepoId) {
      const hostSelection = settingsNavigationTarget.hostId
        ? getSettingsTargetHostSelection(
            settingsProjectList,
            targetRepoId,
            settingsNavigationTarget.hostId
          )
        : repoIdToHostSelection.get(targetRepoId)
      if (hostSelection) {
        setSettingsProjectHostSelection(
          hostSelection.selectionKey,
          hostSelection.hostId,
          'setupId' in hostSelection && typeof hostSelection.setupId === 'string'
            ? hostSelection.setupId
            : undefined
        )
      }
    }
    if (settingsNavigationTarget.hostScope) {
      setSettingsHostChoice(settingsNavigationTarget.hostScope)
    }
    pendingNavSectionRef.current = paneSectionId
    pendingScrollTargetRef.current = settingsNavigationTarget.sectionId ?? paneSectionId
    setHighlightedSettingsTargetId(
      settingsNavigationTarget.pane === 'developer-permissions'
        ? (settingsNavigationTarget.sectionId ?? null)
        : null
    )
    // Open Appearance’s nested status-bar section before scrolling to its rows.
    if (settingsNavigationTarget.pane === 'appearance') {
      const accordion = resolveAppearanceAccordionDeepLink(settingsNavigationTarget.sectionId)
      if (accordion) {
        useAppStore.getState().setAppearanceAccordionDeepLink(accordion)
      }
    }
    if (settingsNavigationTarget.intent === 'add-quick-command') {
      setQuickCommandAddIntentSignal((signal) => signal + 1)
    } else if (settingsNavigationTarget.intent === 'add-ssh-host') {
      setSshHostAddIntentSignal((signal) => signal + 1)
    } else if (settingsNavigationTarget.intent === 'add-remote-orca-server') {
      setRemoteServerAddIntentSignal((signal) => signal + 1)
    }
    setMountedSectionIds((previous) => {
      if (previous.has(paneSectionId)) {
        return previous
      }
      return new Set(previous).add(paneSectionId)
    })
    // Pending refs cannot rerun scrolling; trigger a render even if visible sections stay unchanged.
    setPendingNavRequestTick((tick) => tick + 1)
    clearSettingsTarget()
  }, [
    clearSettingsTarget,
    pendingNavSectionRef,
    pendingScrollTargetRef,
    repoIdToHostSelection,
    repoIdToRepresentative,
    setHighlightedSettingsTargetId,
    setMountedSectionIds,
    setPendingNavRequestTick,
    setQuickCommandAddIntentSignal,
    setRemoteServerAddIntentSignal,
    setSettingsHostChoice,
    setSettingsProjectHostSelection,
    setSshHostAddIntentSignal,
    settings,
    settingsProjectList,
    settingsNavigationTarget
  ])
}
