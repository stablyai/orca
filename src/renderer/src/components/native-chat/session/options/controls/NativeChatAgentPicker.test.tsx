// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type {
  SessionOptionDescriptor,
  SessionOptionsSurface
} from '../../../../../../../shared/native-chat/input/native-chat-session-options'
import { NativeChatSessionOptionPickers } from './NativeChatSessionOptionPickers'

const agent: SessionOptionDescriptor = {
  id: 'agent',
  label: 'Agent',
  transport: 'agent-session',
  valueSource: 'reported',
  settable: true,
  kind: {
    type: 'select',
    currentValue: 'build',
    choices: [
      { value: 'build', label: 'Build' },
      { value: 'review', label: 'Review', description: 'Review changes' }
    ]
  }
}

afterEach(cleanup)

it('offers advertised agents without a model and retains the saved selection while a write is pending or fails', async () => {
  let reject: (error: Error) => void = () => {}
  const setOption = vi.fn(
    () =>
      new Promise<{ snapshot: SessionOptionDescriptor[] }>((_, fail) => {
        reject = fail
      })
  )
  const surface: SessionOptionsSurface = {
    getSnapshot: () => [agent],
    subscribe: () => () => {},
    setOption,
    invokeAction: async () => ({ snapshot: [] })
  }
  render(
    <TooltipProvider>
      <NativeChatSessionOptionPickers surface={surface} snapshot={[agent]} isWorking={false} />
    </TooltipProvider>
  )
  const trigger = screen.getByRole('button', { name: /Build/ })
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' })
  const choice = await screen.findByRole('menuitemradio', { name: /Review/ })
  fireEvent.click(choice)
  expect(setOption).toHaveBeenCalledWith('agent', 'review')
  expect(screen.getByRole('button', { name: /Build/ }).getAttribute('aria-busy')).toBe('true')
  await act(async () => reject(new Error('refused')))
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /Build/ }).getAttribute('aria-busy')).toBeNull()
  )
})

it('does not render an agent selector when the capability is absent', () => {
  const surface: SessionOptionsSurface = {
    getSnapshot: () => [],
    subscribe: () => () => {},
    setOption: async () => ({ snapshot: [] }),
    invokeAction: async () => ({ snapshot: [] })
  }
  render(
    <TooltipProvider>
      <NativeChatSessionOptionPickers surface={surface} snapshot={[]} isWorking={false} />
    </TooltipProvider>
  )
  expect(screen.queryByRole('button')).toBeNull()
})

it('updates the visible selection when the host returns a different next-message agent', () => {
  const surface: SessionOptionsSurface = {
    getSnapshot: () => [agent],
    subscribe: () => () => {},
    setOption: async () => ({ snapshot: [] }),
    invokeAction: async () => ({ snapshot: [] })
  }
  const renderPicker = (snapshot: SessionOptionDescriptor[]) => (
    <TooltipProvider>
      <NativeChatSessionOptionPickers surface={surface} snapshot={snapshot} isWorking={false} />
    </TooltipProvider>
  )
  const view = render(renderPicker([agent]))
  expect(screen.getByRole('button', { name: /Build/ })).toBeTruthy()
  if (agent.kind.type !== 'select') {
    throw new Error('Expected select')
  }
  view.rerender(renderPicker([{ ...agent, kind: { ...agent.kind, currentValue: 'review' } }]))
  expect(screen.getByRole('button', { name: /Review/ })).toBeTruthy()
})

it('disables agent selection when the host is not ready even without a model', () => {
  const surface: SessionOptionsSurface = {
    getSnapshot: () => [agent],
    subscribe: () => () => {},
    setOption: vi.fn(),
    invokeAction: async () => ({ snapshot: [] })
  }
  render(
    <TooltipProvider>
      <NativeChatSessionOptionPickers
        surface={surface}
        snapshot={[{ ...agent, settable: false }]}
        isWorking={false}
      />
    </TooltipProvider>
  )
  const trigger = screen.getByRole('button', { name: /Build/ })
  expect(trigger.hasAttribute('disabled')).toBe(true)
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' })
  expect(screen.queryByRole('menuitemradio', { name: /Review/ })).toBeNull()
  expect(surface.setOption).not.toHaveBeenCalled()
})
