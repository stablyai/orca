// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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

it('lets a queued switch be turned back before the reply finishes, leaving nothing to apply', () => {
  const model: SessionOptionDescriptor = {
    id: 'model',
    label: 'Model',
    category: 'model',
    transport: 'catalog',
    settable: true,
    valueSource: 'applied',
    kind: { type: 'select', currentValue: 'opus', choices: [{ value: 'opus', label: 'Opus' }] }
  }
  const fast: SessionOptionDescriptor = {
    id: 'fast',
    label: 'Fast',
    category: 'speed',
    transport: 'catalog',
    settable: true,
    valueSource: 'applied',
    kind: { type: 'boolean', currentValue: false }
  }
  const writes: unknown[] = []
  const surface = {
    getSnapshot: () => [model, fast],
    subscribe: () => () => {},
    setOption: async (id: string, value: unknown) => {
      writes.push([id, value])
      return { snapshot: [model, fast] }
    },
    invokeAction: async () => ({ snapshot: [model, fast] })
  }
  const view = (isWorking: boolean) => (
    <TooltipProvider>
      <NativeChatSessionOptionPickers
        snapshot={[model, fast]}
        isWorking={isWorking}
        surface={surface}
      />
    </TooltipProvider>
  )
  const { rerender } = render(view(true))
  fireEvent.click(screen.getByRole('button', { name: /Model/ }))
  fireEvent.click(screen.getByRole('switch'))
  expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true')
  fireEvent.click(screen.getByRole('switch'))
  expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false')
  rerender(view(false))
  expect(writes).toEqual([])
})
