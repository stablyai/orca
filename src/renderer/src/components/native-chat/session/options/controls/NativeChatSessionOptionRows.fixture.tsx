import { useState } from 'react'
import { defineFixture } from '../../../../../component-fixtures/component-fixture'
import { i18n, loadRendererUiLanguage } from '@/i18n/i18n'
import { useTranslation } from 'react-i18next'
import { CODEX_SESSION_OPTION_CATALOG } from '../../../../../../../shared/agent-session/options/agent-session-option-catalog-claude-codex'
import { buildNativeChatSessionOptionSnapshot } from '../../../../../../../shared/native-chat/input/native-chat-session-option-snapshot'
import { createNativeChatSessionOptionRecord } from '../../../../../../../shared/native-chat/input/native-chat-session-option-state'
import { NativeChatSessionOptionRows } from './NativeChatSessionOptionRows'
import { NativeChatSessionOptionPickers } from './NativeChatSessionOptionPickers'

function snapshot(current: string, unlisted = false) {
  const record = createNativeChatSessionOptionRecord('codex')
  record.model = { value: 'example', source: 'reported' }
  record.valuesByModel.example = { effort: { value: current, source: 'reported' } }
  return buildNativeChatSessionOptionSnapshot({
    catalog: CODEX_SESSION_OPTION_CATALOG,
    models: [
      {
        id: 'example',
        label: 'Example model',
        options: [
          {
            id: 'effort',
            label: 'Effort',
            category: 'thought_level',
            kind: {
              type: 'select',
              defaultValue: 'low',
              choices: (unlisted
                ? ['low', 'medium', 'high']
                : ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
              ).map((value) => ({ value, label: value }))
            },
            apply: { midSession: { kind: 'unsupported' } }
          }
        ]
      }
    ],
    record,
    mode: 'live',
    modelLabel: 'Model',
    liveTransport: 'agent-session'
  })
}

function EffortExample({
  current = 'xhigh',
  unlisted = false,
  inline = false
}: {
  current?: string
  unlisted?: boolean
  inline?: boolean
}): React.JSX.Element {
  useTranslation()
  const [value, setValue] = useState(current)
  return (
    <div className="native-chat-appearance rounded-md border border-border bg-popover p-1 text-popover-foreground">
      <NativeChatSessionOptionRows
        options={snapshot(value, unlisted).filter((descriptor) => descriptor.id !== 'model')}
        shownReason={null}
        pendingIds={new Set()}
        layout={inline ? 'inline' : 'menu'}
        onSet={(_descriptor, next) => {
          if (typeof next === 'string') {
            setValue(next)
          }
        }}
        onAction={() => {}}
      />
    </div>
  )
}

function PickerExample(): React.JSX.Element {
  const [value, setValue] = useState('low')
  const [writes, setWrites] = useState<string[]>([])
  const options = snapshot(value)
  return (
    <div className="native-chat-appearance flex h-96 flex-col justify-end gap-3">
      <NativeChatSessionOptionPickers
        snapshot={options}
        isWorking={false}
        surface={{
          getSnapshot: () => options,
          setOption: async (id, next) => {
            setWrites((previous) => [...previous, `${id}: ${String(next)}`])
            await new Promise((resolve) => setTimeout(resolve, 150))
            if (id === 'effort' && typeof next === 'string') {
              setValue(next)
            }
            return { snapshot: options }
          },
          invokeAction: async () => ({ snapshot: options }),
          subscribe: () => () => {}
        }}
      />
      <output aria-label="Applied changes" className="text-xs text-chat-foreground-faint">
        {writes.join('; ') || 'None'}
      </output>
    </div>
  )
}

export const effort = defineFixture({ width: 320, render: () => <EffortExample /> })
export const high = defineFixture({ width: 320, render: () => <EffortExample current="high" /> })
export const unlisted = defineFixture({
  width: 320,
  render: () => <EffortExample current="extra-high" unlisted />
})
export const inline = defineFixture({ width: 320, render: () => <EffortExample inline /> })
export const picker = defineFixture({
  width: 390,
  render: () => <PickerExample />,
  interact: (frame) => {
    frame.querySelector('button')?.click()
  }
})
export const russian = defineFixture({
  width: 320,
  render: () => <EffortExample />,
  interact: async () => {
    await i18n.changeLanguage(await loadRendererUiLanguage('ru'))
  }
})
