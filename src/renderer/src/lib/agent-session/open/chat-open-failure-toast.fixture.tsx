import { useEffect } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { i18n, loadRendererUiLanguage } from '@/i18n/i18n'
import { Toaster } from '@/components/ui/sonner'
import type { UiLanguage } from '../../../../../shared/i18n/ui-language'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { showChatOpenUnavailable } from './chat-open-failure-toast'

const LIVE_TOAST = '[data-sonner-toast]:not([data-removed="true"])'
const AGENT = 'Test agent'
const DETAIL = 'unreachable · structured_session_restore_timeout'

function ToastStage({ starting }: { starting: boolean }): React.JSX.Element {
  useEffect(() => {
    showChatOpenUnavailable(
      starting ? { starting: true } : { detail: DETAIL, retry: () => undefined },
      AGENT
    )
    return () => {
      toast.dismiss()
    }
  }, [starting])
  // A transform makes this frame the toaster's fixed-position containing block, like a 600px window.
  return (
    <div className="relative h-[260px] w-[600px] [transform:translateZ(0)]">
      <Toaster
        closeButton
        toastOptions={{ className: 'font-sans text-sm', duration: Number.POSITIVE_INFINITY }}
      />
    </div>
  )
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = performance.now() + 3000
  while (!check()) {
    if (performance.now() > deadline) {
      throw new Error(`Timed out waiting for ${label}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/** The title must stay on one line at the toaster's width, in every locale. */
function assertOneLineTitle(): void {
  const title = document.querySelector<HTMLElement>(`${LIVE_TOAST} [data-title]`)
  if (!title) {
    throw new Error('The toast title is missing')
  }
  const range = document.createRange()
  range.selectNodeContents(title)
  const lines = new Set([...range.getClientRects()].map((rect) => Math.round(rect.bottom)))
  if (lines.size > 1) {
    throw new Error(`The toast title wraps: ${title.textContent}`)
  }
}

async function raise(language: UiLanguage, starting: boolean): Promise<void> {
  await i18n.changeLanguage(await loadRendererUiLanguage(language))
  // The toast reads its words when shown, so raise it in the loaded language.
  showChatOpenUnavailable(
    starting ? { starting: true } : { detail: DETAIL, retry: () => undefined },
    AGENT
  )
  await waitFor(
    () => document.querySelector(LIVE_TOAST)?.getAttribute('data-mounted') === 'true',
    'the toast'
  )
  await new Promise((resolve) => setTimeout(resolve, 400))
}

function chatOpenToast(language: UiLanguage, starting: boolean, expanded = false) {
  return defineFixture({
    // Orca's narrowest window; the toaster is min(26rem, 100vw - 2rem) wide.
    width: 600,
    setup: () => {
      useAppStore.setState((state) => ({
        settings: state.settings && { ...state.settings, uiLanguage: language }
      }))
    },
    render: () => <ToastStage starting={starting} />,
    interact: async () => {
      await raise(language, starting)
      assertOneLineTitle()
      if (expanded) {
        const toggle = document.querySelector<HTMLButtonElement>(
          `${LIVE_TOAST} button[aria-expanded]`
        )
        toggle?.click()
        await waitFor(() => toggle?.getAttribute('aria-expanded') === 'true', 'the details')
      }
    }
  })
}

const LANGUAGES: UiLanguage[] = [
  'en',
  'de',
  'es',
  'fr',
  'ja',
  'ko',
  'pt',
  'ru',
  'tr',
  'zh',
  'zh-Hant'
]

/** Both titles fit one line in every built-in locale; shows the last one checked. */
export const everyLocaleOneLine = defineFixture({
  width: 600,
  render: () => <ToastStage starting={false} />,
  interact: async () => {
    for (const language of LANGUAGES) {
      for (const starting of [true, false]) {
        await raise(language, starting)
        assertOneLineTitle()
      }
    }
  }
})

export const stillStartingEn = chatOpenToast('en', true)
export const stillStartingDe = chatOpenToast('de', true)
export const stillStartingRu = chatOpenToast('ru', true)
export const openFailedEn = chatOpenToast('en', false)
export const openFailedDe = chatOpenToast('de', false)
export const openFailedRu = chatOpenToast('ru', false)
export const openFailedDetailsDe = chatOpenToast('de', false, true)
export const openFailedDetailsRu = chatOpenToast('ru', false, true)
