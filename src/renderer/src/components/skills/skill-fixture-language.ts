import { i18n } from '@/i18n/i18n'
import { useAppStore } from '@/store/index'
import type { BuiltInUiLanguage } from '../../../../shared/i18n/ui-language'

// Why only the saved setting: the frame's I18nProvider is then the one owner of the language and
// drops a request from an earlier story, so a ready shot can't switch language afterwards.

/** Fixture `setup`: pin the story's language before its first render, keeping the theme. */
export function pinFixtureLanguage(language: BuiltInUiLanguage): void {
  useAppStore.setState(({ settings }) =>
    settings ? { settings: { ...settings, uiLanguage: language } } : {}
  )
}

const nextFrame = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => resolve()))

/** Fixture `interact`: report ready only once the provider has applied the pinned language. */
export async function waitForFixtureLanguage(
  frame: HTMLElement,
  language: BuiltInUiLanguage
): Promise<void> {
  for (let tick = 0; i18n.language !== language && tick < 600; tick++) {
    await nextFrame()
    // Why: a replaced story stops waiting, so it can't report on its successor.
    if (!frame.isConnected) {
      return
    }
  }
  if (i18n.language !== language) {
    throw new Error(`Fixture stayed in ${i18n.language}, not ${language}`)
  }
  await nextFrame()
  await nextFrame()
}
