import { defineFixture } from '../../../../../component-fixtures/component-fixture'
import { NativeChatModelCombobox } from './NativeChatModelCombobox'
import { useState } from 'react'
import { NativeChatSessionOptionPickers } from './NativeChatSessionOptionPickers'
import {
  applyStructuredAgentSessionOptions,
  commitStructuredAgentSessionOption,
  createStructuredAgentSessionOptionState
} from '../../../../../../../shared/agent-session/options/structured-agent-session-options'
import { structuredAgentSessionOptionSnapshot } from '../../../../../../../shared/agent-session/options/view/structured-agent-session-option-snapshot'
import type { AgentSessionContextMode } from '../../../../../../../shared/agent-session/options/model-catalog/agent-session-context-mode'

const choices = [
  {
    value: 'GPT-6.1-Sol',
    label: 'GPT-6.1-Sol',
    description: 'Model load: 52%. Daily quota: 15% left (85% used); resets 06:00.'
  },
  {
    value: 'GPT-6-Astra',
    label: 'GPT-6-Astra',
    description: 'Model load: 352%. Weekly quota: 70% left (30% used); resets 00:00.'
  },
  { value: 'Seed-Code', label: 'Seed-Code' }
]

export const models = defineFixture({
  width: 520,
  render: () => (
    <div className="native-chat-appearance p-4">
      <NativeChatModelCombobox
        choices={choices}
        currentValue="GPT-6.1-Sol"
        readOnly={false}
        readOnlyReason={null}
        busy={false}
        onSelect={() => {}}
      />
    </div>
  )
})

export const narrow = defineFixture({ width: 320, render: models.render })

function ContextPicker({ mode }: { mode: AgentSessionContextMode }) {
  const [state, setState] = useState(() => {
    const seed = { models: [], modelApply: {} }
    return applyStructuredAgentSessionOptions(
      createStructuredAgentSessionOptionState('trae', seed),
      seed,
      {
        models: [
          {
            id: 'large',
            label: 'Large model',
            isDefault: true,
            efforts: [],
            supportsMaxMode: true
          },
          {
            id: 'small',
            label: 'Standard model',
            isDefault: false,
            efforts: [],
            supportsMaxMode: false
          }
        ],
        current: { model: 'large', contextMode: mode, confirmed: ['contextMode'] }
      }
    )
  })
  const snapshot = structuredAgentSessionOptionSnapshot(state)
  return (
    <div className="native-chat-appearance p-4">
      <NativeChatSessionOptionPickers
        snapshot={snapshot}
        isWorking={false}
        surface={{
          getSnapshot: () => snapshot,
          subscribe: () => () => {},
          invokeAction: async () => ({ snapshot }),
          setOption: async (id, value) => {
            const next = commitStructuredAgentSessionOption(state, id, String(value))
            setState(next)
            return { snapshot: structuredAgentSessionOptionSnapshot(next) }
          }
        }}
      />
    </div>
  )
}

export const standardContext = defineFixture({
  width: 520,
  render: () => <ContextPicker mode="standard" />,
  interact: (frame) => frame.querySelector<HTMLButtonElement>('button')?.click()
})

export const maxContext = defineFixture({
  width: 520,
  render: () => <ContextPicker mode="max" />,
  interact: standardContext.interact
})

export const narrowContext = defineFixture({
  width: 320,
  render: maxContext.render,
  interact: maxContext.interact
})
