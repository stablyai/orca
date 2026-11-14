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

it('exposes the current selection on keyboard focus and follows the chat snapshot', async () => {
  const model: SessionOptionDescriptor = {
    id: 'model',
    label: 'Model',
    category: 'model',
    transport: 'agent-session',
    settable: true,
    valueSource: 'applied',
    kind: {
      type: 'select',
      currentValue: 'chat-model',
      choices: [{ value: 'chat-model', label: 'Chat model' }]
    }
  }
  const effort: SessionOptionDescriptor = {
    id: 'effort',
    label: 'Effort',
    transport: 'agent-session',
    settable: true,
    valueSource: 'applied',
    kind: {
      type: 'select',
      currentValue: 'xhigh',
      choices: [{ value: 'xhigh', label: 'Extra high' }]
    }
  }
  const surface = {
    getSnapshot: () => [model, effort],
    subscribe: () => () => {},
    setOption: async () => ({ snapshot: [model, effort] }),
    invokeAction: async () => ({ snapshot: [model, effort] })
  }
  const picker = (snapshot: SessionOptionDescriptor[]) => (
    <TooltipProvider>
      <NativeChatSessionOptionPickers snapshot={snapshot} surface={surface} isWorking={true} />
    </TooltipProvider>
  )
  const view = render(picker([model, effort]))
  fireEvent.focus(screen.getByRole('button'))
  const tooltip = await screen.findByRole('tooltip')
  expect(tooltip.textContent).toBe('Chat model · Extra high')
  expect(screen.getByRole('button').getAttribute('aria-label')).toContain('Chat model · Extra high')
  view.rerender(
    picker([
      {
        ...model,
        kind: {
          type: 'select',
          currentValue: 'next',
          choices: [{ value: 'next', label: 'Next chat model' }]
        }
      }
    ])
  )
  expect(screen.getByRole('tooltip').textContent).toBe('Next chat model')
  expect(screen.getByRole('button').getAttribute('aria-label')).toBe('Model Next chat model')
  view.rerender(picker([{ ...model, valueSource: 'unknown' }, effort]))
  expect(screen.getByRole('tooltip').textContent).toBe('Model and effort')
  expect(screen.getByRole('button').getAttribute('aria-label')).not.toContain('Chat model')
  view.rerender(picker([{ ...model, valueSource: 'default' }, effort]))
  expect(screen.getByRole('tooltip').textContent).toBe('Chat model · Extra high')
})

it('keeps a working model-only picker inspectable without allowing changes', async () => {
  const model: SessionOptionDescriptor = {
    id: 'model',
    label: 'Model',
    category: 'model',
    transport: 'catalog',
    settable: true,
    valueSource: 'applied',
    kind: {
      type: 'select',
      currentValue: 'chat-model',
      choices: [{ value: 'chat-model', label: 'Chat model' }]
    }
  }
  const surface = {
    getSnapshot: () => [model],
    subscribe: () => () => {},
    setOption: async () => ({ snapshot: [model] }),
    invokeAction: async () => ({ snapshot: [model] })
  }
  const picker = (isWorking: boolean) => (
    <TooltipProvider>
      <NativeChatSessionOptionPickers snapshot={[model]} surface={surface} isWorking={isWorking} />
    </TooltipProvider>
  )
  const view = render(picker(true))
  const informationalTrigger = screen.getByRole('button', { name: 'Model Chat model' })
  expect(informationalTrigger.getAttribute('aria-disabled')).toBe('true')
  expect(view.container.querySelector('button')?.disabled).toBe(true)
  fireEvent.focus(informationalTrigger)
  expect((await screen.findByRole('tooltip')).textContent).toBe('Chat model')
  fireEvent.click(informationalTrigger)
  for (const key of ['Enter', ' ', 'ArrowDown']) {
    fireEvent.keyDown(informationalTrigger, { key })
  }
  expect(screen.queryByRole('dialog')).toBeNull()
  view.rerender(picker(false))
  fireEvent.click(screen.getByRole('button', { name: 'Model Chat model' }))
  expect(await screen.findByRole('dialog')).not.toBeNull()
})
