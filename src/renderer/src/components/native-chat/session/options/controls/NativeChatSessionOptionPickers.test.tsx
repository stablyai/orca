// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { NativeChatSessionOptionPickers } from './NativeChatSessionOptionPickers'
import type { SessionOptionDescriptor } from '../../../../../../../shared/native-chat/input/native-chat-session-options'

afterEach(cleanup)

it('shows the selected model when legacy answering-model metadata names another model', () => {
  const model: SessionOptionDescriptor & { reportedModel: string } = {
    id: 'model',
    label: 'Model',
    category: 'model',
    transport: 'agent-session',
    settable: true,
    valueSource: 'applied',
    reportedModel: 'claude-opus-4-8',
    kind: {
      type: 'select',
      currentValue: 'claude-opus-5-5',
      choices: [
        { value: 'claude-opus-5-5', label: 'Opus 5.5' },
        { value: 'claude-opus-4-8', label: 'Opus 4.8' }
      ]
    }
  }
  render(
    <TooltipProvider>
      <NativeChatSessionOptionPickers
        snapshot={[model]}
        isWorking={true}
        surface={{
          getSnapshot: () => [model],
          subscribe: () => () => {},
          setOption: async () => ({ snapshot: [model] }),
          invokeAction: async () => ({ snapshot: [model] })
        }}
      />
    </TooltipProvider>
  )
  expect(screen.getByRole('button', { name: 'Model Opus 5.5' }).textContent).toBe('Opus 5.5')
})
