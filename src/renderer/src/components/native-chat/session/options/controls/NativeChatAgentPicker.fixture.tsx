import { useState } from 'react'
import { defineFixture } from '../../../../../component-fixtures/component-fixture'
import type { SessionOptionDescriptor } from '../../../../../../../shared/native-chat/input/native-chat-session-options'
import { NativeChatSessionOptionPickers } from './NativeChatSessionOptionPickers'

function AgentPickerFixture() {
  const [current, setCurrent] = useState('build')
  const agent: SessionOptionDescriptor = {
    id: 'agent',
    label: 'Agent',
    transport: 'agent-session',
    valueSource: 'reported',
    settable: true,
    kind: {
      type: 'select',
      currentValue: current,
      choices: [
        { value: 'build', label: 'Build', description: 'Make changes to the project' },
        { value: 'plan', label: 'Plan', description: 'Explore and plan before making changes' },
        { value: 'review', label: 'Review', description: 'Review changes and identify issues' }
      ]
    }
  }
  return (
    <div className="native-chat-appearance flex h-48 items-end justify-end p-4">
      <NativeChatSessionOptionPickers
        isWorking={false}
        snapshot={[agent]}
        surface={{
          getSnapshot: () => [agent],
          subscribe: () => () => {},
          setOption: async (_id, value) => {
            if (typeof value === 'string') {
              setCurrent(value)
            }
            return { snapshot: [agent] }
          },
          invokeAction: async () => ({ snapshot: [agent] })
        }}
      />
    </div>
  )
}

export const agent = defineFixture({
  width: 640,
  render: () => <AgentPickerFixture />,
  interact: (frame) => {
    frame
      .querySelector('button')
      ?.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })
      )
  }
})
