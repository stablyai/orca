import { useCallback, useEffect, useRef, useState } from 'react'
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

export type SettingsInteractionModel = Pick<
  SettingsStoreModel,
  | 'closeSettingsPage'
  | 'confirm'
  | 'hasUnsavedBranchPromptChanges'
  | 'hasUnsavedChatPromptChanges'
  | 'hasUnsavedCommitPromptChanges'
  | 'highlightedSettingsTargetId'
  | 'setFontSuggestions'
  | 'setHasUnsavedBranchPromptChanges'
  | 'setHasUnsavedChatPromptChanges'
  | 'setHasUnsavedCommitPromptChanges'
  | 'setHighlightedSettingsTargetId'
  | 'setSettingsSearchQuery'
  | 'setSourceControlAiPromptDiscardSignal'
  | 'settings'
  | 'updateSettingsOrThrow'
>

export function useSettingsInteractionController(model: SettingsInteractionModel) {
  const {
    closeSettingsPage,
    confirm,
    hasUnsavedBranchPromptChanges,
    hasUnsavedChatPromptChanges,
    hasUnsavedCommitPromptChanges,
    highlightedSettingsTargetId,
    setFontSuggestions,
    setHasUnsavedBranchPromptChanges,
    setHasUnsavedChatPromptChanges,
    setHasUnsavedCommitPromptChanges,
    setHighlightedSettingsTargetId,
    setSettingsSearchQuery,
    setSourceControlAiPromptDiscardSignal,
    settings,
    updateSettingsOrThrow
  } = model
  const contentScrollRef = useRef<HTMLDivElement | null>(null)
  // Windowed lists need a render when the scroller attaches.
  const [contentScrollElement, setContentScrollElement] = useState<HTMLDivElement | null>(null)
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
    hasUnsavedCommitPromptChanges || hasUnsavedBranchPromptChanges || hasUnsavedChatPromptChanges
  // The once-registered close guard reads current dirty state through a ref.
  const hasUnsavedSourceControlAiPromptChangesRef = useRef(hasUnsavedSourceControlAiPromptChanges)
  hasUnsavedSourceControlAiPromptChangesRef.current = hasUnsavedSourceControlAiPromptChanges

  const writeSourceControlAiSettingsOrThrow = useCallback(
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
          await updateSettingsOrThrow({ sourceControlAi: { ...latestConfig, ...resolvedPatch } })
        })
      sourceControlAiWriteQueueRef.current = next
      return next
    },
    [settings, updateSettingsOrThrow]
  )

  const writeSourceControlAiSettings = useCallback(
    (patch: SourceControlAiSettingsPatch): Promise<void> =>
      writeSourceControlAiSettingsOrThrow(patch).catch((error: unknown) => {
        console.error('Failed to update settings:', error)
      }),
    [writeSourceControlAiSettingsOrThrow]
  )

  const setSettingsRootNode = useCallback(
    (node: HTMLDivElement | null): void => {
      if (node) {
        return
      }
      // Clear transient search on close so later visits do not inherit hidden sections.
      setSettingsSearchQuery('')
    },
    [setSettingsSearchQuery]
  )

  const setContentScrollNode = useCallback((node: HTMLDivElement | null): void => {
    contentScrollRef.current = node
    setContentScrollElement(node)
    if (node !== null) {
      return
    }
    // Cancel pending subsection jumps so stale frames cannot run after close.
    cancelPendingSettingsSubsectionScrollFrame(pendingSubsectionScrollFrameRef)
    cancelPendingSettingsDeepLinkTargetWatch(pendingScrollTargetWatchRef)
  }, [])

  useEffect(() => {
    // StrictMode replays mount effects; font requests may still commit while mounted.
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
        // Latch successful empty results too so font-less systems do not repeatedly list fonts.
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

  // Ask without clearing drafts because a later close guard may still veto.
  const promptDiscardSourceControlAiPromptChanges = useCallback((): Promise<boolean> => {
    return confirm({
      title: translate(
        'auto.components.settings.Settings.17bdee4ff1',
        'Discard unsaved AI settings?'
      ),
      description: translate(
        'auto.components.settings.Settings.43b68e10f0',
        'You have unsaved AI settings. Leaving will discard them.'
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
      setHasUnsavedChatPromptChanges(false)
    }
    return shouldDiscard
  }, [
    promptDiscardSourceControlAiPromptChanges,
    hasUnsavedSourceControlAiPromptChanges,
    setSourceControlAiPromptDiscardSignal,
    setHasUnsavedCommitPromptChanges,
    setHasUnsavedBranchPromptChanges,
    setHasUnsavedChatPromptChanges
  ])

  const closeSettingsPageWithPromptGuard = useCallback(async (): Promise<void> => {
    if (!(await confirmDiscardSourceControlAiPromptChanges())) {
      return
    }
    closeSettingsPage()
  }, [closeSettingsPage, confirmDiscardSourceControlAiPromptChanges])

  return {
    contentScrollRef,
    contentScrollElement,
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
    writeSourceControlAiSettingsOrThrow,
    setSettingsRootNode,
    setContentScrollNode,
    requestFontSuggestions,
    promptDiscardSourceControlAiPromptChanges,
    confirmDiscardSourceControlAiPromptChanges,
    closeSettingsPageWithPromptGuard
  }
}

export type SettingsInteractionController = ReturnType<typeof useSettingsInteractionController>
