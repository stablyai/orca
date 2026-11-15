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
      <NativeChatSessionOptionPickers snapshot={snapshot} surface={surface} isWorking={false} />
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
  view.rerender(picker([{ ...model, transport: 'catalog', valueSource: 'dispatched' }]))
  const trigger = screen.getByRole('button', { name: 'Model Chat model' })
  const descriptionId = trigger.getAttribute('aria-describedby')
  expect(descriptionId).not.toBeNull()
  expect(document.getElementById(descriptionId!)?.textContent).toContain(
    'Sent to the agent — not confirmed'
  )
})

function queuedPickFixture() {
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
    category: 'model_config',
    transport: 'catalog',
    settable: true,
    valueSource: 'applied',
    kind: { type: 'boolean', currentValue: false }
  }
  const writes: unknown[] = []
  const surfaceFor = (sessionKey: string) => ({
    sessionKey,
    getSnapshot: () => [model, fast],
    subscribe: () => () => {},
    setOption: async (id: string, value: unknown) => {
      writes.push([id, value])
      return { snapshot: [model, fast] }
    },
    invokeAction: async () => ({ snapshot: [model, fast] })
  })
  const surfaces = { a: surfaceFor('a'), b: surfaceFor('b') }
  const view = (isWorking: boolean, session: 'a' | 'b' = 'a') => (
    <TooltipProvider>
      <NativeChatSessionOptionPickers
        snapshot={[model, fast]}
        isWorking={isWorking}
        surface={surfaces[session]}
      />
    </TooltipProvider>
  )
  return { writes, view }
}

it('lets a queued switch be turned back before the reply finishes, leaving nothing to apply', () => {
  const { writes, view } = queuedPickFixture()
  const { rerender } = render(view(true))
  fireEvent.click(screen.getByRole('button', { name: /Model/ }))
  fireEvent.click(screen.getByRole('switch'))
  expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true')
  fireEvent.click(screen.getByRole('switch'))
  expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false')
  rerender(view(false))
  expect(writes).toEqual([])
})

it('drops a pick queued for one session when the pane moves to another', () => {
  const { writes, view } = queuedPickFixture()
  const { rerender } = render(view(true))
  fireEvent.click(screen.getByRole('button', { name: /Model/ }))
  fireEvent.click(screen.getByRole('switch'))
  rerender(view(true, 'b'))
  rerender(view(false, 'b'))
  expect(writes).toEqual([])
})
