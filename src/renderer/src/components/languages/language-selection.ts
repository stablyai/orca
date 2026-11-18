import { toast } from 'sonner'
import {
  isPluginUiLanguage,
  normalizeUiLanguage,
  type UiLanguage
} from '../../../../shared/i18n/ui-language'
import { loadRendererUiLanguage, translate } from '@/i18n/i18n'
import { useLanguageReadiness } from '@/i18n/language-readiness'
import { useAppStore } from '@/store'

let selectionRevision = 0
let saving: Promise<void> = Promise.resolve()

export const uiLanguageSelectionRevision = (): number => selectionRevision

export async function selectUiLanguage(
  next: UiLanguage,
  canCommit: () => boolean = () => true
): Promise<boolean> {
  const revision = ++selectionRevision
  if (!isPluginUiLanguage(next)) {
    await loadRendererUiLanguage(next)
  }
  const result = saving.then(async () => {
    if (revision !== selectionRevision || !canCommit()) {
      return false
    }
    const { settings } = useAppStore.getState()
    if (!settings) {
      throw new Error('Settings unavailable')
    }
    const current = settings.uiLanguage
    await useAppStore.getState().updateSettingsOrThrow({
      uiLanguage: next,
      languagePackSuggestionShown: true,
      ...(isPluginUiLanguage(next) && !isPluginUiLanguage(current)
        ? { uiLanguageBeforePlugin: current }
        : {})
    })
    if (next === current && useLanguageReadiness.getState().error) {
      useLanguageReadiness.getState().retryLanguageLoad()
    }
    return revision === selectionRevision && useAppStore.getState().settings?.uiLanguage === next
  })
  saving = result.then(
    () => undefined,
    () => undefined
  )
  return result
}

export async function restorePreviousUiLanguage(canCommit?: () => boolean): Promise<boolean> {
  const previous = normalizeUiLanguage(
    useAppStore.getState().settings?.uiLanguageBeforePlugin ?? 'en'
  )
  return selectUiLanguage(previous, canCommit)
}

export function showLanguageChanged(name: string): void {
  toast.success(translate('languages.nowUsing', 'Now using {{language}}', { language: name }), {
    id: 'language-changed',
    duration: 12000,
    action: {
      label: translate('languages.switchBack', 'Switch back'),
      onClick: () => void restorePreviousUiLanguage().catch(showLanguageSelectionError)
    }
  })
}

export function showLanguageSelectionError(): void {
  toast.error(translate('languages.changeFailed', 'Could not change language. Try again.'))
}
