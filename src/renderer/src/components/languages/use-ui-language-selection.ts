import { useEffect, useRef, useState } from 'react'
import {
  isPluginUiLanguage,
  normalizeUiLanguage,
  type UiLanguage
} from '../../../../shared/i18n/ui-language'
import { useTranslate } from '@/i18n/use-translate'
import { track } from '@/diagnostics/telemetry/telemetry'
import { useAppStore } from '@/store'
import { onboardingLanguageMetadata } from '../onboarding/onboarding-language-telemetry'
import {
  selectUiLanguage,
  restorePreviousUiLanguage,
  showLanguageChanged
} from './language-selection'

export function useUiLanguageSelection({
  onboarding,
  onClose,
  disabled,
  announce = true
}: {
  onboarding: boolean
  onClose: () => void
  disabled: boolean
  /** False when a modal stays open over the toast layer and confirms the change itself. */
  announce?: boolean
}) {
  const t = useTranslate()
  const [selecting, setSelecting] = useState<UiLanguage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const selectionPending = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const choose = async (language: UiLanguage, name: string): Promise<void> => {
    if (selectionPending.current || disabled) {
      return
    }
    selectionPending.current = true
    setSelecting(language)
    setError(null)
    try {
      if (await selectUiLanguage(language, () => mounted.current)) {
        if (onboarding) {
          track('onboarding_language_changed', {
            ...onboardingLanguageMetadata(),
            selected_language: language
          })
        }
        if (announce && isPluginUiLanguage(language)) {
          showLanguageChanged(name)
        }
        if (mounted.current && !onboarding) {
          onClose()
        }
      }
    } catch {
      if (mounted.current) {
        setError(t('languages.changeFailed', 'Could not change language. Try again.'))
      }
    }
    selectionPending.current = false
    if (mounted.current) {
      setSelecting(null)
    }
  }
  const restore = async (): Promise<void> => {
    if (selectionPending.current || disabled) {
      return
    }
    selectionPending.current = true
    // Why the real target: marking English busy would spin the wrong row when restoring System.
    setSelecting(
      normalizeUiLanguage(useAppStore.getState().settings?.uiLanguageBeforePlugin ?? 'en')
    )
    setError(null)
    try {
      if (await restorePreviousUiLanguage(() => mounted.current)) {
        if (onboarding) {
          track('onboarding_language_changed', {
            ...onboardingLanguageMetadata(),
            selected_language: useAppStore.getState().settings?.uiLanguage ?? 'en'
          })
        }
      }
    } catch {
      if (mounted.current) {
        setError(t('languages.changeFailed', 'Could not change language. Try again.'))
      }
    }
    selectionPending.current = false
    if (mounted.current) {
      setSelecting(null)
    }
  }
  return { selecting, error, choose, restore }
}
