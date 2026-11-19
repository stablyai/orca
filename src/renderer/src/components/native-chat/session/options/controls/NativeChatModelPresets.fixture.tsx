import { translate } from '@/i18n/i18n'
import { defineFixture } from '../../../../../component-fixtures/component-fixture'
import { NativeChatSessionOptionPickers } from './NativeChatSessionOptionPickers'
import type { SessionOptionDescriptor } from '../../../../../../../shared/native-chat/input/native-chat-session-options'

const snapshot: SessionOptionDescriptor[] = [
  {
    id: 'model',
    label: 'Model',
    category: 'model',
    transport: 'agent-session',
    settable: true,
    valueSource: 'applied',
    kind: {
      type: 'select',
      currentValue: 'strong',
      choices: [
        { value: 'strong', label: 'Reasoning model' },
        { value: 'quick', label: 'Fast model' }
      ]
    }
  },
  {
    id: 'effort',
    label: 'Effort',
    category: 'thought_level',
    transport: 'agent-session',
    settable: true,
    valueSource: 'applied',
    kind: {
      type: 'select',
      currentValue: 'high',
      choices: [
        { value: 'low', label: 'Low' },
        { value: 'high', label: 'High' }
      ]
    }
  },
  {
    id: 'fastMode',
    label: 'Speed',
    category: 'model_config',
    transport: 'agent-session',
    settable: true,
    valueSource: 'applied',
    kind: { type: 'boolean', currentValue: true }
  }
]

export const picker = defineFixture({
  width: 640,
  render: () => (
    <div
      className="native-chat-appearance flex h-128 items-end justify-end p-4"
      data-native-chat-root="true"
    >
      <NativeChatSessionOptionPickers
        presetScope="fixture:model-presets"
        surface={{
          getSnapshot: () => snapshot,
          subscribe: () => () => {},
          setOption: async () => ({ snapshot }),
          invokeAction: async () => ({ snapshot })
        }}
        snapshot={snapshot}
        isWorking={false}
      />
    </div>
  ),
  interact: async (frame) => {
    frame.querySelector<HTMLButtonElement>('button')?.click()
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    const slot = Array.from(document.querySelectorAll('button')).find(
      (button) =>
        button.getAttribute('aria-label') ===
        translate('components.native-chat.modelPresets.slot', 'Slot {{slot}}', { slot: 1 })
    )
    if (slot?.getAttribute('aria-pressed') !== 'true') {
      slot?.dispatchEvent(
        new MouseEvent('click', {
          bubbles: true,
          altKey: navigator.userAgent.includes('Mac'),
          ctrlKey: !navigator.userAgent.includes('Mac')
        })
      )
    }
  }
})

export const narrow = defineFixture({ ...picker, width: 360 })

export const assigning = defineFixture({
  ...picker,
  interact: async (frame) => {
    await picker.interact?.(frame)
    const isMac = navigator.userAgent.includes('Mac')
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: isMac ? 'Alt' : 'Control',
        code: isMac ? 'AltLeft' : 'ControlLeft',
        altKey: isMac,
        ctrlKey: !isMac,
        bubbles: true
      })
    )
  }
})
