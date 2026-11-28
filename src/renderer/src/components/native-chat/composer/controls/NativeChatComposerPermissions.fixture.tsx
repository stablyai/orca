import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { getDefaultSettings } from '../../../../../../shared/orca-profiles/constants'
import type { UiLanguage } from '../../../../../../shared/i18n/ui-language'
import type {
  SessionOptionDescriptor,
  SessionOptionsSurface
} from '../../../../../../shared/native-chat/input/native-chat-session-options'
import { setRendererUiLanguage } from '@/i18n/i18n'
import { NativeChatComposerActions } from './NativeChatComposerActions'
import { NativeChatPermissionModePicker } from '../../session/options/controls/NativeChatPermissionModePicker'

const noop = (): void => {}
const paint = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))

type PermissionState = {
  current: string
  reported?: string
  /** The English name the tooltip and accessible name must carry. */
  name: string
  /** The lucide icon the pill shows: the mode's menu icon, or the settings icon. */
  icon: string
  /** The English hint the tooltip adds under the name. */
  hint?: string
}

const STATES = {
  ask: { current: 'ask', name: 'Ask for approval', icon: 'hand' },
  acceptEdits: { current: 'accept-edits', name: 'Accept edits', icon: 'file-pen-line' },
  auto: { current: 'auto', name: 'Approve for me', icon: 'shield-check' },
  fullAccess: { current: 'full-access', name: 'Full access', icon: 'shield-alert' },
  // Own settings before the agent reports a mode.
  fallback: {
    current: 'own',
    name: 'Claude Code settings',
    icon: 'settings-2',
    hint: 'Uses your Claude Code permission settings.'
  },
  // Own settings with a reported mode Orca has no name for.
  unnamed: {
    current: 'own',
    reported: 'read-only',
    name: 'Claude Code settings',
    icon: 'settings-2',
    hint: "Orca can't show this mode."
  },
  // A saved value this build doesn't recognize.
  unknown: { current: 'legacy-mode', name: 'Permissions', icon: 'settings-2' }
} satisfies Record<string, PermissionState>

function permissionFixture({
  state,
  language = 'en',
  width = 720,
  focus
}: {
  state: PermissionState
  language?: UiLanguage
  width?: number
  /** Opens the pill's tooltip by keyboard focus or pointer hover. */
  focus?: 'keyboard' | 'hover'
}) {
  let sent = false
  const snapshot: SessionOptionDescriptor[] = [
    {
      id: 'permissionMode',
      label: 'Permissions',
      category: 'mode',
      transport: 'agent-session',
      valueSource: 'applied',
      settable: true,
      kind: {
        type: 'select',
        currentValue: state.current,
        reportedValue: state.reported,
        settingsAgent: 'claude',
        choices: [
          { value: 'ask', label: 'Ask for approval' },
          { value: 'accept-edits', label: 'Accept edits' },
          { value: 'auto', label: 'Approve for me' },
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
    store: {
      settings: {
        ...getDefaultSettings('/home/fixture'),
        uiLanguage: language
      }
    },
    render: () => (
      <div
        data-composer-field
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
          agent="claude"
        />
      </div>
    ),
    interact: async (frame) => {
      sent = false
      await setRendererUiLanguage(language)
      await paint()
      const host = frame.querySelector<HTMLElement>('[data-composer-field]')!
      const pill = host.querySelector<HTMLButtonElement>(
        '[data-composer-control="permissions"] button'
      )
      if (!pill) {
        throw new Error('The composer must show the permission pill')
      }
      // The closed pill is the mode's neutral icon alone at every width; the name lives in its
      // accessible name and tooltip.
      const glyphs = Array.from(pill.querySelectorAll('svg'))
      if (
        pill.innerText.trim() !== '' ||
        glyphs.length !== 1 ||
        getComputedStyle(glyphs[0]).visibility !== 'visible'
      ) {
        throw new Error('The permission pill must show only its icon')
      }
      const accessibleName = pill.getAttribute('aria-label') ?? ''
      if (language === 'en' ? !accessibleName.includes(state.name) : accessibleName === '') {
        throw new Error(`The permission pill must be named "${state.name}" for assistive tech`)
      }
      const pillBox = pill.getBoundingClientRect()
      if (Math.abs(pillBox.width - 28) > 0.5 || Math.abs(pillBox.height - 28) > 0.5) {
        throw new Error('The permission pill must be a 28px square')
      }
      // The narrower pill leaves room for the model name even in the narrowest composer.
      const model = host.querySelector<HTMLElement>('[data-composer-control="model"] button')
      if (!model?.innerText.includes('Opus 5.5')) {
        throw new Error('The model name must stay visible beside the permission pill')
      }
      const icon = glyphs[0].getBoundingClientRect()
      const attach = host.querySelector<HTMLElement>('[data-composer-control="attach"] button')!
      const attachBox = attach.getBoundingClientRect()
      const centerY = (box: DOMRect): number => box.top + box.height / 2
      if (
        Math.abs(icon.left - pillBox.left - (pillBox.right - icon.right)) > 0.5 ||
        Math.abs(centerY(icon) - centerY(pillBox)) > 0.5 ||
        Math.abs(centerY(pillBox) - centerY(attachBox)) > 0.5
      ) {
        throw new Error('The permission icon must sit centered in its pill, in line with Attach')
      }
      if (!glyphs[0].classList.contains(`lucide-${state.icon}`)) {
        throw new Error(`The permission pill must show the ${state.icon} icon`)
      }
      // Every mode, Full access included, shares Attach's neutral colour on the closed pill.
      if (getComputedStyle(glyphs[0]).color !== getComputedStyle(attach).color) {
        throw new Error('The permission icon must stay neutral like its neighbours')
      }
      if (accessibleName.split(/\s+/).filter((word) => word === 'Permissions').length > 1) {
        throw new Error('The permission pill must not repeat its title in its accessible name')
      }
      const send = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).at(-1)!
      const controls = Array.from(host.querySelectorAll<HTMLElement>('[data-composer-control]'))
        .filter((control) => getComputedStyle(control).visibility === 'visible')
        .map((control) => control.getBoundingClientRect())
      const bounds = host.getBoundingClientRect()
      const sendBounds = send.getBoundingClientRect()
      if (
        controls.some(
          (control) =>
            control.left < bounds.left ||
            control.right > bounds.right + 1 ||
            control.right > sendBounds.left
        )
      ) {
        throw new Error('Composer controls must stay in bounds and clear of Send')
      }
      send.click()
      if (!sent) {
        throw new Error('Send must remain available')
      }
      if (!focus) {
        return
      }
      if (focus === 'keyboard') {
        // Tooltips open on keyboard focus only, so record a key press before focusing the pill.
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
        pill.focus()
      } else {
        pill.dispatchEvent(
          new PointerEvent('pointermove', {
            bubbles: true,
            pointerType: 'mouse'
          })
        )
      }
      let content: HTMLElement | null = null
      for (let attempt = 0; attempt < 60 && !content; attempt += 1) {
        await paint()
        content = document.querySelector<HTMLElement>('[data-slot="tooltip-content"]')
      }
      if (!content) {
        throw new Error('The permission tooltip must open on focus and hover')
      }
      await Promise.allSettled(content.getAnimations().map((animation) => animation.finished))
      const box = content.getBoundingClientRect()
      if (
        box.left < 0 ||
        box.top < 0 ||
        box.right > window.innerWidth ||
        box.bottom > window.innerHeight
      ) {
        throw new Error('The permission tooltip must be fully visible')
      }
      if (language === 'en' && !content.innerText.includes(state.name)) {
        throw new Error(`The permission tooltip must name "${state.name}"`)
      }
      if (language === 'en' && state.hint && !content.innerText.includes(state.hint)) {
        throw new Error(`The permission tooltip must keep its hint "${state.hint}"`)
      }
    }
  })
}

// Every state at the wide and narrowest composer, in English and Simplified Chinese.
export const ask = permissionFixture({ state: STATES.ask })
export const acceptEdits = permissionFixture({ state: STATES.acceptEdits })
export const auto = permissionFixture({ state: STATES.auto })
export const fullAccess = permissionFixture({ state: STATES.fullAccess })
export const fallback = permissionFixture({ state: STATES.fallback })
export const unnamed = permissionFixture({ state: STATES.unnamed })
export const unknown = permissionFixture({ state: STATES.unknown })
export const askNarrow = permissionFixture({ state: STATES.ask, width: 300 })
export const acceptEditsNarrow = permissionFixture({
  state: STATES.acceptEdits,
  width: 300
})
export const autoNarrow = permissionFixture({ state: STATES.auto, width: 300 })
export const fullAccessNarrow = permissionFixture({
  state: STATES.fullAccess,
  width: 300
})
export const fallbackNarrow = permissionFixture({
  state: STATES.fallback,
  width: 300
})
export const unnamedNarrow = permissionFixture({
  state: STATES.unnamed,
  width: 300
})
export const unknownNarrow = permissionFixture({
  state: STATES.unknown,
  width: 300
})
export const zhAsk = permissionFixture({ state: STATES.ask, language: 'zh' })
export const zhAcceptEdits = permissionFixture({
  state: STATES.acceptEdits,
  language: 'zh'
})
export const zhAuto = permissionFixture({ state: STATES.auto, language: 'zh' })
export const zhFullAccess = permissionFixture({
  state: STATES.fullAccess,
  language: 'zh'
})
export const zhFallback = permissionFixture({
  state: STATES.fallback,
  language: 'zh'
})
export const zhUnnamed = permissionFixture({
  state: STATES.unnamed,
  language: 'zh'
})
export const zhUnknown = permissionFixture({
  state: STATES.unknown,
  language: 'zh'
})
export const zhFullAccessNarrow = permissionFixture({
  state: STATES.fullAccess,
  language: 'zh',
  width: 300
})
export const zhFallbackNarrow = permissionFixture({
  state: STATES.fallback,
  language: 'zh',
  width: 300
})
// The tooltip names the mode by hover and by keyboard focus, which also shows the focus ring.
export const fullAccessHover = permissionFixture({
  state: STATES.fullAccess,
  focus: 'hover'
})
export const fullAccessKeyboard = permissionFixture({
  state: STATES.fullAccess,
  focus: 'keyboard'
})
export const fallbackKeyboard = permissionFixture({
  state: STATES.fallback,
  focus: 'keyboard'
})
export const unnamedKeyboard = permissionFixture({ state: STATES.unnamed, focus: 'keyboard' })
export const unknownKeyboard = permissionFixture({ state: STATES.unknown, focus: 'keyboard' })
export const zhFullAccessHover = permissionFixture({
  state: STATES.fullAccess,
  language: 'zh',
  focus: 'hover'
})
export const zhFallbackKeyboardNarrow = permissionFixture({
  state: STATES.fallback,
  language: 'zh',
  width: 300,
  focus: 'keyboard'
})

// Outside the composer (Settings > Chat when per-agent permissions are unsupported) the picker keeps
// its name; only the composer asks for the icon-only pill.
export const settingsPicker = defineFixture({
  width: 320,
  render: () => (
    <NativeChatPermissionModePicker
      current="full-access"
      modes={['ask', 'accept-edits', 'auto', 'full-access']}
      onSelect={noop}
    />
  ),
  interact: async (frame) => {
    await paint()
    const trigger = frame.querySelector<HTMLButtonElement>('button')!
    if (!trigger.innerText.includes('Full access')) {
      throw new Error('The settings permission picker must keep its mode name')
    }
  }
})
