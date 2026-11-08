// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Editor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { focusMountedNativeChatEditor } from '../editor/native-chat-mounted-editor-view'
import { TooltipProvider } from '@/components/ui/tooltip'
import { NativeChatComposerActions } from './NativeChatComposerActions'
import type {
  SessionOptionDescriptor,
  SessionOptionsSurface
} from '../../../../../../shared/native-chat/input/native-chat-session-options'

vi.mock('@/i18n/use-ui-language-revision', () => ({ useUiLanguageRevision: () => 0 }))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    Object.entries(values ?? {}).reduce(
      (text, [key, value]) => text.replaceAll(`{{${key}}}`, value),
      fallback
    )
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('keeps current mode, permissions and Goal reachable through overflow, including pending writes, then restores direct controls', async () => {
  let width = 140
  const observers = new Set<() => void>()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        observers.add(() => callback([], this))
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return this.hasAttribute('data-compact') ? width : 0
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    const compact = this.closest('[data-compact]')?.getAttribute('data-compact') === 'true'
    const sizes: Record<string, [number, number]> = {
      attach: [32, 32],
      plan: [56, 26],
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
      id: 'model',
      label: 'Model',
      category: 'model',
      transport: 'agent-session',
      valueSource: 'applied',
      settable: true,
      kind: {
        type: 'select',
        currentValue: 'first',
        choices: [
          { value: 'first', label: 'Long provider model' },
          { value: 'second', label: 'Second model' }
        ]
      }
    },
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
  const editor = new Editor({
    extensions: [StarterKit],
    editorProps: { attributes: { role: 'textbox', 'aria-label': 'Chat message' } }
  })
  const focus = () => focusMountedNativeChatEditor(editor)
  const resize = (next: number) => {
    width = next
    act(() => observers.forEach((observer) => observer()))
  }
  const view = render(
    <TooltipProvider>
      <EditorContent editor={editor} />
      <input aria-label="Outside composer" />
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
  const partial = screen.getByRole('dialog')
  const menuMode = within(partial).getByRole('button', { name: 'Exit plan mode' })
  const menuPermission = within(partial).getByRole('button', { name: 'Permissions Full access' })
  menuPermission.focus()
  resize(1000)
  expect(within(partial).getByRole('button', { name: 'Exit plan mode' })).toBe(menuMode)
  expect(within(partial).getByRole('button', { name: 'Permissions Full access' })).toBe(
    menuPermission
  )
  expect(document.activeElement).toBe(menuPermission)
  fireEvent.click(screen.getByRole('button', { name: 'More chat controls' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Chat message' }))
  )
  resize(100)
  fireEvent.click(screen.getByRole('button', { name: 'More chat controls' }))
  resize(1000)
  const outside = screen.getByRole('textbox', { name: 'Outside composer' })
  fireEvent.pointerDown(outside)
  outside.focus()
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(document.activeElement).toBe(outside)
  resize(100)
  fireEvent.click(screen.getByRole('button', { name: 'More chat controls' }))
  const popup = screen.getByRole('dialog')
  await act(async () =>
    fireEvent.click(within(popup).getByRole('button', { name: 'Exit plan mode' }))
  )
  expect(setOption).toHaveBeenLastCalledWith('interactionMode', 'default')
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Chat message' }))
  )
  fireEvent.click(screen.getByRole('button', { name: 'More chat controls' }))
  expect(
    within(screen.getByRole('dialog')).getByRole('button', { name: 'Exit plan mode' })
  ).toHaveProperty('disabled', true)
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
  resize(1000)
  const buttons = screen
    .getAllByRole('button')
    .map((button) => button.getAttribute('aria-label') ?? button.textContent)
  expect(buttons.slice(0, 4)).toEqual([
    'Attach file',
    'Permissions Full access',
    'Exit plan mode',
    'Exit goal mode'
  ])
  expect(screen.queryByRole('button', { name: 'More chat controls' })).toBeNull()
  const model = screen.getByRole('button', { name: 'Model Long provider model' })
  fireEvent.click(model)
  const modelPopup = screen.getByRole('dialog')
  resize(50)
  expect(screen.getByRole('button', { name: 'Model Long provider model' })).toBe(model)
  expect(screen.getByRole('dialog')).toBe(modelPopup)
  fireEvent.click(within(modelPopup).getByRole('option', { name: /Second model/ }))
  expect(setOption).toHaveBeenLastCalledWith('model', 'second')
  resize(1000)
  expect(screen.getByRole('dialog')).toBe(modelPopup)
  expect(screen.getByRole('button', { name: 'Model Second model' })).toBe(model)
  await act(async () => settle())
  view.unmount()
  editor.destroy()
})
