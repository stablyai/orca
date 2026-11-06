// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { NativeChatComposerActions } from './NativeChatComposerActions'
import type {
  SessionOptionDescriptor,
  SessionOptionsSurface
} from '../../../../shared/native-chat/input/native-chat-session-options'

vi.mock('@/i18n/use-ui-language-revision', () => ({ useUiLanguageRevision: () => 0 }))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    Object.entries(values ?? {}).reduce(
      (text, [key, value]) => text.replaceAll(`{{${key}}}`, value),
      fallback
    )
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('./NativeChatSessionOptionPickers', () => ({
  NativeChatSessionOptionPickers: () => (
    <button aria-label="Model with a long provider label">
      <span data-composer-label>Model with a long provider label</span>
    </button>
  )
}))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('keeps current mode, permissions and Goal reachable through overflow, including pending writes, then restores direct controls', async () => {
  let width = 140
  const observers = new Set<ResizeObserverCallback>()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        observers.add(callback)
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function () {
    return this.hasAttribute('data-compact') ? width : 0
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    const compact = this.closest('[data-compact]')?.getAttribute('data-compact') === 'true'
    const sizes: Record<string, [number, number]> = {
      attach: [32, 32],
      mode: [56, 26],
      permissions: [112, 26],
      goal: [54, 24],
      model: [260, 26],
      dictation: [32, 32],
      cancel: [60, 60]
    }
    const id = this.dataset.composerControl
    const measured = id
      ? (sizes[id]?.[Number(compact)] ?? 0)
      : this.querySelector('button[aria-label="More chat controls"]')
        ? 24
        : 48
    return {
      x: 0,
      y: 0,
      width: measured,
      height: 24,
      top: 0,
      left: 0,
      bottom: 24,
      right: measured,
      toJSON() {}
    }
  })
  let settle = () => {}
  const setOption = vi.fn<SessionOptionsSurface['setOption']>().mockImplementation(
    () =>
      new Promise((resolve) => {
        settle = () => resolve({ snapshot: [] })
      })
  )
  const surface: SessionOptionsSurface = {
    getSnapshot: () => [],
    setOption,
    invokeAction: async () => ({ snapshot: [] }),
    subscribe: () => () => {}
  }
  const snapshot: SessionOptionDescriptor[] = [
    {
      id: 'interactionMode',
      label: 'Mode',
      category: 'mode',
      transport: 'agent-session',
      valueSource: 'applied',
      settable: true,
      kind: {
        type: 'select',
        currentValue: 'plan',
        choices: [
          { value: 'default', label: 'Build' },
          { value: 'plan', label: 'Plan' }
        ]
      }
    },
    {
      id: 'permissionMode',
      label: 'Permissions',
      transport: 'agent-session',
      valueSource: 'applied',
      settable: true,
      kind: {
        type: 'select',
        currentValue: 'full-access',
        choices: [
          { value: 'ask', label: 'Ask' },
          { value: 'full-access', label: 'Full access' }
        ]
      }
    }
  ]
  const exitGoal = vi.fn()
  const focus = vi.fn()
  const view = render(
    <TooltipProvider>
      <NativeChatComposerActions
        attachDisabled={false}
        dictationDisabled={false}
        sendDisabled={false}
        isWorking={false}
        isDictating={false}
        isDictationHoldMode={false}
        onAttach={vi.fn()}
        onDictationToggle={vi.fn()}
        onDictationHoldStart={vi.fn()}
        onDictationHoldEnd={vi.fn()}
        onSend={vi.fn()}
        sessionOptionsSurface={surface}
        sessionOptionsSnapshot={snapshot}
        focusComposer={focus}
        onExitGoalMode={exitGoal}
        editSession={{ cancel: vi.fn() }}
      />
    </TooltipProvider>
  )
  fireEvent.click(screen.getByRole('button', { name: 'More chat controls' }))
  const popup = screen.getByRole('dialog')
  expect(within(popup).getByRole('button', { name: 'Plan' }).getAttribute('aria-pressed')).toBe(
    'true'
  )
  await act(async () => fireEvent.click(within(popup).getByRole('button', { name: 'Build' })))
  expect(setOption).toHaveBeenLastCalledWith('interactionMode', 'default')
  fireEvent.click(screen.getByRole('button', { name: 'More chat controls' }))
  expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'Plan' })).toHaveProperty(
    'disabled',
    true
  )
  await act(async () => settle())
  const permission = within(screen.getByRole('dialog')).getByRole('button', {
    name: 'Permissions Full access'
  })
  fireEvent.pointerDown(permission, { button: 0, ctrlKey: false })
  await act(async () => fireEvent.click(screen.getByRole('menuitemradio', { name: /Ask/ })))
  expect(setOption).toHaveBeenLastCalledWith('permissionMode', 'ask')
  await act(async () => settle())
  fireEvent.click(
    within(screen.getByRole('dialog')).getByRole('button', { name: 'Exit goal mode' })
  )
  expect(exitGoal).toHaveBeenCalledOnce()
  expect(focus).toHaveBeenCalled()
  width = 1000
  act(() => {
    for (const observer of observers) {
      observer([], {} as ResizeObserver)
    }
  })
  const buttons = screen
    .getAllByRole('button')
    .map((button) => button.getAttribute('aria-label') ?? button.textContent)
  expect(buttons.slice(0, 4)).toEqual([
    'Attach file',
    'Plan',
    'Permissions Full access',
    'Exit goal mode'
  ])
  expect(screen.queryByRole('button', { name: 'More chat controls' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Model with a long provider label' })).toBeTruthy()
  view.unmount()
})
