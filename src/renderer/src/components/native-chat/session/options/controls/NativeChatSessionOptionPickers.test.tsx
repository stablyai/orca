// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { NativeChatSessionOptionPickers } from './NativeChatSessionOptionPickers'
import type { SessionOptionDescriptor } from '../../../../../../../shared/native-chat/input/native-chat-session-options'

afterEach(cleanup)

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
