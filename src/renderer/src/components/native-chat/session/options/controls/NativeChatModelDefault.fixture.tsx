import { defineFixture } from '../../../../../component-fixtures/component-fixture'
import { NativeChatSessionOptionPickers } from './NativeChatSessionOptionPickers'
import type { SessionOptionDescriptor } from '../../../../../../../shared/native-chat/input/native-chat-session-options'

const MODELS = [
  { value: 'claude-opus-5-5', label: 'Opus 5.5', description: 'Most capable for complex work' },
  { value: 'claude-sonnet-5', label: 'Sonnet 5', description: 'Best for everyday tasks' },
  { value: 'claude-haiku-4-5', label: 'Haiku 4.5', description: 'Fastest for quick answers' }
]

const EFFORT: SessionOptionDescriptor = {
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
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' }
    ]
  }
}

function model(
  currentValue: string | undefined,
  valueSource: SessionOptionDescriptor['valueSource'],
  defaultSelected: boolean
): SessionOptionDescriptor {
  return {
    id: 'model',
    label: 'Model',
    category: 'model',
    transport: 'agent-session',
    settable: true,
    valueSource,
    kind: { type: 'select', currentValue, choices: MODELS },
    defaultChoice: { selected: defaultSelected }
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 250))

function picker(snapshot: SessionOptionDescriptor[]) {
  return defineFixture({
    width: 420,
    render: () => (
      <div className="flex min-h-[380px] items-end bg-background p-4">
        <NativeChatSessionOptionPickers
          surface={{
            getSnapshot: () => snapshot,
            subscribe: () => () => {},
            setOption: async () => ({ snapshot }),
            invokeAction: async () => ({ snapshot }),
            resetOption: async () => ({ snapshot })
          }}
          isWorking={false}
          snapshot={snapshot}
        />
      </div>
    ),
    interact: async () => {
      const trigger = document.querySelector<HTMLElement>('button[aria-haspopup="dialog"]')
      trigger?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
      trigger?.click()
      await settle()
    }
  })
}

/** A model picked in an earlier chat, which every new chat used to inherit. */
export const pickedModel = picker([model('claude-haiku-4-5', 'applied', false), EFFORT])

/** Default in a chat that ran: the host named the model the agent is configured with. */
export const defaultResolved = picker([model('claude-opus-5-5', 'applied', true), EFFORT])

/** Default in a new chat: the agent picks its model when it starts. */
export const defaultBeforeStart = picker([model(undefined, 'unknown', true), EFFORT])
