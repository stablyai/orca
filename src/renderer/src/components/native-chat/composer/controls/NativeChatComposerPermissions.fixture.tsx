import type { CSSProperties } from 'react'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { getDefaultSettings } from '../../../../../../shared/orca-profiles/constants'
import type { UiLanguage } from '../../../../../../shared/i18n/ui-language'
import type {
  SessionOptionDescriptor,
  SessionOptionsSurface
} from '../../../../../../shared/native-chat/input/native-chat-session-options'
import { setRendererUiLanguage } from '@/i18n/i18n'
import { NativeChatComposerActions } from './NativeChatComposerActions'

const noop = (): void => {}
const paint = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))

function permissionFixture({
  language = 'en',
  reported,
  current = 'own',
  active,
  width = 767,
  tooltip = false,
  chatTextPx,
  agent = 'claude'
}: {
  language?: UiLanguage
  reported?: string
  agent?: string
  current?: string
  active?: string
  /** Opens the pill's tooltip by keyboard focus and checks it is fully on screen. */
  tooltip?: boolean
  width?: number
  /** Chat text size setting; controls and spacing scale with it. */
  chatTextPx?: number
} = {}) {
  const chatScale:
    | (CSSProperties & Record<'--chat-font-size' | '--chat-ui-font-size', string>)
    | undefined = chatTextPx
    ? { '--chat-font-size': `${chatTextPx}px`, '--chat-ui-font-size': `${chatTextPx}px` }
    : undefined
  let sent = false
  const snapshot: SessionOptionDescriptor[] = [
    {
      id: 'permissionMode',
      label: 'Permissions',
      category: 'mode',
      transport: 'agent-session',
      valueSource: active ? 'dispatched' : 'applied',
      activeValue: active,
      settable: true,
      kind: {
        type: 'select',
        currentValue: current,
        reportedValue: reported,
        settingsAgent: agent,
        choices: [
          { value: 'ask', label: 'Ask for approval' },
          { value: 'accept-edits', label: 'Accept edits' },
          { value: 'full-access', label: 'Full access' }
        ]
      }
    },
    {
      id: 'model',
      label: 'Model',
      category: 'model',
      transport: 'agent-session',
      valueSource: 'applied',
      settable: true,
      kind: {
        type: 'select',
        currentValue: 'opus',
        choices: [{ value: 'opus', label: 'Opus 5.5' }]
      }
    }
  ]
  const surface: SessionOptionsSurface = {
    getSnapshot: () => snapshot,
    subscribe: () => noop,
    setOption: async () => ({ snapshot }),
    invokeAction: async () => ({ snapshot })
  }
  return defineFixture({
    width,
    store: { settings: { ...getDefaultSettings('/home/fixture'), uiLanguage: language } },
    render: () => (
      <div
        data-composer-field
        style={chatScale}
        className="native-chat-appearance rounded-xl border border-chat-composer-border bg-chat-composer-surface p-1.5"
      >
        <NativeChatComposerActions
          attachDisabled={false}
          dictationDisabled
          sendDisabled={false}
          isWorking={false}
          isDictating={false}
          isDictationHoldMode={false}
          onAttach={noop}
          onDictationToggle={noop}
          onDictationHoldStart={noop}
          onDictationHoldEnd={noop}
          onSend={() => {
            sent = true
          }}
          sessionOptionsSurface={surface}
          sessionOptionsSnapshot={snapshot}
          agent={agent}
        />
      </div>
    ),
    interact: async (frame) => {
      sent = false
      await setRendererUiLanguage(language)
      await paint()
      const host = frame.querySelector<HTMLElement>('[data-composer-field]')!
      const label = host.querySelector<HTMLElement>(
        '[data-composer-control="permissions"] [data-composer-label]'
      )!
      const labelShown = getComputedStyle(label).visibility === 'visible'
      if (width >= 767 && !labelShown) {
        throw new Error('The permission text must be fully visible when the composer has room')
      }
      if (!active && labelShown && label.scrollWidth > label.clientWidth + 1) {
        throw new Error(
          'A permission name must show in full or compact to its icon, never truncate'
        )
      }
      const originalWidth = frame.style.width
      frame.style.width = '292px'
      await paint()
      const bounds = host.getBoundingClientRect()
      const controls = Array.from(host.querySelectorAll<HTMLElement>('[data-composer-control]'))
        .filter((control) => getComputedStyle(control).visibility === 'visible')
        .map((control) => control.getBoundingClientRect())
      if (
        controls.some((control) => control.left < bounds.left || control.right > bounds.right + 1)
      ) {
        throw new Error('A narrow composer must keep its controls within its bounds')
      }
      const narrowLabel = host.querySelector<HTMLElement>(
        '[data-composer-control="permissions"] [data-composer-label]'
      )!
      if (
        getComputedStyle(narrowLabel).visibility === 'visible' &&
        narrowLabel.scrollWidth > narrowLabel.clientWidth + 1 &&
        narrowLabel.clientWidth < 96
      ) {
        throw new Error(
          'A narrow composer must compact the permission pill, not clip it to a sliver'
        )
      }
      const send = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).at(-1)!
      const sendBounds = send.getBoundingClientRect()
      if (controls.some((control) => control.right > sendBounds.left)) {
        throw new Error('Permission controls must not cover Send in a narrow composer')
      }
      send.click()
      if (!sent) {
        throw new Error('Send must remain available in a narrow composer')
      }
      frame.style.width = originalWidth
      await paint()
      if (tooltip) {
        // Tooltips open on keyboard focus only, so record a key press before focusing the pill.
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
        host
          .querySelector<HTMLButtonElement>('[data-composer-control="permissions"] button')!
          .focus()
        let content: HTMLElement | null = null
        for (let attempt = 0; attempt < 60 && !content; attempt += 1) {
          await paint()
          content = document.querySelector<HTMLElement>('[data-slot="tooltip-content"]')
        }
        if (!content) {
          throw new Error('The permission tooltip must open on keyboard focus')
        }
        await Promise.allSettled(content.getAnimations().map((animation) => animation.finished))
        const box = content.getBoundingClientRect()
        const text = content.firstElementChild
        if (
          !(text instanceof HTMLElement) ||
          box.left < 0 ||
          box.top < 0 ||
          box.right > window.innerWidth ||
          box.bottom > window.innerHeight ||
          text.scrollWidth > text.clientWidth + 1 ||
          text.scrollHeight > text.clientHeight + 1
        ) {
          throw new Error('The permission tooltip must be fully visible')
        }
      }
    }
  })
}

export const unknown = permissionFixture()
// With no report, the tooltip names the settings and promises no mode.
export const unknownTooltip = permissionFixture({ tooltip: true })
export const unknownTooltipNarrow = permissionFixture({ width: 292, tooltip: true })
// Codex in read-only reports a mode Orca has no name for.
export const unnamedTooltip = permissionFixture({
  language: 'pt',
  agent: 'codex',
  reported: 'read-only',
  tooltip: true
})
export const reportedTooltip = permissionFixture({ reported: 'full-access', tooltip: true })
export const reported = permissionFixture({ reported: 'full-access' })
export const longFallback = permissionFixture({ language: 'pt' })
export const longFallbackEs = permissionFixture({ language: 'es' })
// Split panes leave the composer between the wide and narrow layouts.
export const longFallback420 = permissionFixture({ language: 'pt', width: 420 })
export const longFallback480 = permissionFixture({ language: 'pt', width: 480 })
export const longFallback520 = permissionFixture({ language: 'pt', width: 520 })
export const longFallbackEs420 = permissionFixture({ language: 'es', width: 420 })
export const longFallbackEs480 = permissionFixture({ language: 'es', width: 480 })
export const longFallbackEs520 = permissionFixture({ language: 'es', width: 520 })
export const longFallbackTooltip = permissionFixture({ language: 'pt', tooltip: true })
// The largest chat text setting scales the pill and the toolbar's measurement together.
export const longFallbackScaled = permissionFixture({ language: 'pt', chatTextPx: 20 })
export const longFallbackScaled460 = permissionFixture({
  language: 'pt',
  width: 460,
  chatTextPx: 20
})
export const longFallbackScaled520 = permissionFixture({
  language: 'pt',
  width: 520,
  chatTextPx: 20
})
export const longMode = permissionFixture({ language: 'fr', reported: 'accept-edits' })
export const longModeRu = permissionFixture({ language: 'ru', reported: 'ask' })
export const narrow = permissionFixture({ width: 292 })
export const deferred = permissionFixture({ language: 'fr', current: 'full-access', active: 'own' })
