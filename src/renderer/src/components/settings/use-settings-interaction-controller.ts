import { useCallback, useEffect, useRef } from 'react'
import type { SourceControlAiSettingsPatch } from '../../../../shared/source-control-ai-types'
import { useAppStore } from '../../store'
import { translate } from '@/i18n/i18n'
import { mergeFontSuggestions } from './SettingsConstants'
import type { SettingsStoreModel } from './use-settings-store-model'
import type { SettingsDeepLinkTargetWatch } from './settings-deep-link-target-watcher'
import {
  cancelPendingSettingsDeepLinkTargetWatch,
  cancelPendingSettingsSubsectionScrollFrame,
  readSourceControlAiSettings,
  SETTINGS_TARGET_HIGHLIGHT_MS
} from './settings-navigation-foundations'

export function useSettingsInteractionController(model: SettingsStoreModel) {
  const {
    closeSettingsPage,
    confirm,
    hasUnsavedBranchPromptChanges,
    hasUnsavedCommitPromptChanges,
    highlightedSettingsTargetId,
    setFontSuggestions,
    setHasUnsavedBranchPromptChanges,
    setHasUnsavedCommitPromptChanges,
    setHighlightedSettingsTargetId,
    setSettingsSearchQuery,
    setSourceControlAiPromptDiscardSignal,
    settings,
    updateSettings
  } = model
  const contentScrollRef = useRef<HTMLDivElement | null>(null)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const installedFontsLoadedRef = useRef(false)
  const installedFontsLoadPromiseRef = useRef<Promise<void> | null>(null)
  const settingsMountedRef = useRef(true)
  const pendingNavSectionRef = useRef<string | null>(null)
  const pendingScrollTargetRef = useRef<string | null>(null)
  const pendingSubsectionScrollFrameRef = useRef<number | null>(null)
  const pendingScrollTargetWatchRef = useRef<SettingsDeepLinkTargetWatch | null>(null)
  const repoHooksRequestSeqRef = useRef(0)
  const shortcutsEscapeConfirmUntilRef = useRef(0)
  const sourceControlAiWriteQueueRef = useRef<Promise<void>>(undefined!)
  sourceControlAiWriteQueueRef.current ??= Promise.resolve()

  const hasUnsavedSourceControlAiPromptChanges =
    hasUnsavedCommitPromptChanges || hasUnsavedBranchPromptChanges
  // Why: the close guard registers once, so it reads latest dirty state from a ref instead of a lagging closure.
  const hasUnsavedSourceControlAiPromptChangesRef = useRef(hasUnsavedSourceControlAiPromptChanges)
  hasUnsavedSourceControlAiPromptChangesRef.current = hasUnsavedSourceControlAiPromptChanges

  const writeSourceControlAiSettings = useCallback(
    (patch: SourceControlAiSettingsPatch): Promise<void> => {
      const next = sourceControlAiWriteQueueRef.current
        .catch(() => undefined)
        .then(async () => {
          const latestSettings = useAppStore.getState().settings ?? settings
          if (!latestSettings) {
            return
          }

          const latestConfig = readSourceControlAiSettings(latestSettings)
          const resolvedPatch = typeof patch === 'function' ? patch(latestConfig) : patch
          await updateSettings({ sourceControlAi: { ...latestConfig, ...resolvedPatch } })
        })
      sourceControlAiWriteQueueRef.current = next
      return next
    },
    [settings, updateSettings]
  )

  const setSettingsRootNode = useCallback(
    (node: HTMLDivElement | null): void => {
      if (node) {
        return
      }
      // Why: clear the transient search filter on close, else the next visit opens with whole sections still hidden.
      setSettingsSearchQuery('')
    },
    [setSettingsSearchQuery]
  )

  const setContentScrollNode = useCallback((node: HTMLDivElement | null): void => {
    contentScrollRef.current = node
    if (node !== null) {
      return
    }
    // Why: cancel pending subsection jumps with the scroll container so a stale deep-link frame can't run after close.
    cancelPendingSettingsSubsectionScrollFrame(pendingSubsectionScrollFrameRef)
    cancelPendingSettingsDeepLinkTargetWatch(pendingScrollTargetWatchRef)
  }, [])

  useEffect(() => {
    // Why: StrictMode replays mount effects; async font requests should still commit while Settings is mounted.
    settingsMountedRef.current = true
    return () => {
      settingsMountedRef.current = false
    }
  }, [])

  useEffect(() => {
    if (!highlightedSettingsTargetId) {
      return
    }
    const timeout = window.setTimeout(
      () => setHighlightedSettingsTargetId(null),
      SETTINGS_TARGET_HIGHLIGHT_MS
    )
    return () => window.clearTimeout(timeout)
  }, [highlightedSettingsTargetId, setHighlightedSettingsTargetId])

  const requestFontSuggestions = useCallback((): void => {
    if (installedFontsLoadedRef.current || installedFontsLoadPromiseRef.current) {
      return
    }

    installedFontsLoadPromiseRef.current = window.api.settings
      .listFonts()
      .then((fonts) => {
        if (!settingsMountedRef.current) {
          return
        }
        // Latch after the first successful attempt even when empty, so a font-less system doesn't reissue listFonts() each time.
        installedFontsLoadedRef.current = true
        if (fonts.length === 0) {
          return
        }
        setFontSuggestions((prev) => mergeFontSuggestions(fonts, prev))
      })
      .catch(() => {
        // Fall back to curated cross-platform suggestions.
      })
      .finally(() => {
        installedFontsLoadPromiseRef.current = null
      })
  }, [setFontSuggestions])

  // Pure prompt (no side effects): the close guard must ask without clearing drafts, since a later guard can still cancel the close.
  const promptDiscardSourceControlAiPromptChanges = useCallback((): Promise<boolean> => {
    return confirm({
      title: translate(
        'auto.components.settings.Settings.17bdee4ff1',
        'Discard unsaved Git AI Author changes?'
      ),
      description: translate(
        'auto.components.settings.Settings.43b68e10f0',
        'You have unsaved Git AI Author changes. Leaving will discard them.'
      ),
      confirmLabel: translate('auto.components.settings.Settings.65358016ea', 'Discard'),
      confirmVariant: 'destructive'
    })
  }, [confirm])

  const confirmDiscardSourceControlAiPromptChanges = useCallback(async (): Promise<boolean> => {
    if (!hasUnsavedSourceControlAiPromptChanges) {
      return true
    }
    const shouldDiscard = await promptDiscardSourceControlAiPromptChanges()
    if (shouldDiscard) {
      setSourceControlAiPromptDiscardSignal((signal) => signal + 1)
      setHasUnsavedCommitPromptChanges(false)
      setHasUnsavedBranchPromptChanges(false)
    }
    return shouldDiscard
  }, [
    promptDiscardSourceControlAiPromptChanges,
    hasUnsavedSourceControlAiPromptChanges,
    setSourceControlAiPromptDiscardSignal,
    setHasUnsavedCommitPromptChanges,
    setHasUnsavedBranchPromptChanges
  ])

  const closeSettingsPageWithPromptGuard = useCallback(async (): Promise<void> => {
    if (!(await confirmDiscardSourceControlAiPromptChanges())) {
      return
    }
    closeSettingsPage()
  }, [closeSettingsPage, confirmDiscardSourceControlAiPromptChanges])

  return {
    contentScrollRef,
    searchInputRef,
    pendingNavSectionRef,
    pendingScrollTargetRef,
    pendingSubsectionScrollFrameRef,
    pendingScrollTargetWatchRef,
    repoHooksRequestSeqRef,
    shortcutsEscapeConfirmUntilRef,
    hasUnsavedSourceControlAiPromptChanges,
    hasUnsavedSourceControlAiPromptChangesRef,
    writeSourceControlAiSettings,
    setSettingsRootNode,
    setContentScrollNode,
    requestFontSuggestions,
    promptDiscardSourceControlAiPromptChanges,
    confirmDiscardSourceControlAiPromptChanges,
    closeSettingsPageWithPromptGuard
  }
}

export type SettingsInteractionController = ReturnType<typeof useSettingsInteractionController>
