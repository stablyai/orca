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
// A server bot's Home that didn't load: one plain reason line, no raw output to disclose.
const HOME_DID_NOT_LOAD = "Bot's Home didn't load."

type ToastKind = 'starting' | 'failed' | 'home'

function toastContext(kind: ToastKind): Parameters<typeof showChatOpenUnavailable>[0] {
  return kind === 'starting'
    ? { starting: true }
    : kind === 'home'
      ? { message: HOME_DID_NOT_LOAD, retry: () => undefined }
      : { detail: DETAIL, retry: () => undefined }
}

function ToastStage({ kind }: { kind: ToastKind }): React.JSX.Element {
  useEffect(() => {
    showChatOpenUnavailable(toastContext(kind), kind === 'home' ? undefined : AGENT)
    return () => {
      toast.dismiss()
    }
  }, [kind])
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
  // Why innermost: Sonner wraps a custom card in its own [data-title], which holds the whole card.
  const title = document.querySelector<HTMLElement>(
    `${LIVE_TOAST} [data-title]:not(:has([data-title]))`
  )
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

async function raise(language: UiLanguage, kind: ToastKind): Promise<void> {
  await i18n.changeLanguage(await loadRendererUiLanguage(language))
  // The toast reads its words when shown, so raise it in the loaded language.
  showChatOpenUnavailable(toastContext(kind), kind === 'home' ? undefined : AGENT)
  await waitFor(
    () => document.querySelector(LIVE_TOAST)?.getAttribute('data-mounted') === 'true',
    'the toast'
  )
  await new Promise((resolve) => setTimeout(resolve, 400))
}

/** The reason shows as one line under the title, with no details disclosure to open. */
function assertPlainReason(): void {
  const reason = document.querySelector<HTMLElement>(`${LIVE_TOAST} [data-message]`)
  if (reason?.textContent !== HOME_DID_NOT_LOAD) {
    throw new Error(`The toast reason is missing: ${reason?.textContent}`)
  }
  if (document.querySelector(`${LIVE_TOAST} button[aria-expanded]`)) {
    throw new Error('A plain reason must not come with a details disclosure')
  }
  const range = document.createRange()
  range.selectNodeContents(reason)
  if (new Set([...range.getClientRects()].map((rect) => Math.round(rect.bottom))).size > 1) {
    throw new Error('The toast reason wraps')
  }
}

function chatOpenToast(language: UiLanguage, kind: ToastKind, expanded = false) {
  return defineFixture({
    // Orca's narrowest window; the toaster is min(26rem, 100vw - 2rem) wide.
    width: 600,
    setup: () => {
      useAppStore.setState((state) => ({
        settings: state.settings && { ...state.settings, uiLanguage: language }
      }))
    },
    render: () => <ToastStage kind={kind} />,
    interact: async () => {
      await raise(language, kind)
      assertOneLineTitle()
      if (kind === 'home') {
        assertPlainReason()
      }
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
  render: () => <ToastStage kind="failed" />,
  interact: async () => {
    for (const language of LANGUAGES) {
      for (const kind of ['starting', 'failed'] as const) {
        await raise(language, kind)
        assertOneLineTitle()
      }
    }
  }
})

export const stillStartingEn = chatOpenToast('en', 'starting')
export const stillStartingDe = chatOpenToast('de', 'starting')
export const stillStartingRu = chatOpenToast('ru', 'starting')
export const openFailedEn = chatOpenToast('en', 'failed')
export const openFailedDe = chatOpenToast('de', 'failed')
export const openFailedRu = chatOpenToast('ru', 'failed')
export const openFailedDetailsDe = chatOpenToast('de', 'failed', true)
export const openFailedDetailsRu = chatOpenToast('ru', 'failed', true)
export const botHomeDidNotLoadEn = chatOpenToast('en', 'home')
