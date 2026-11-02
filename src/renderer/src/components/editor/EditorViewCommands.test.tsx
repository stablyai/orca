// @vitest-environment happy-dom
import { act, useRef, useState, type JSX } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import * as keyboardRouter from '@/lib/app-keyboard-router'
import type { EditorToggleValue } from './view-mode/EditorViewToggle'
import { EditorViewCommands } from './EditorViewCommands'

const initialState = useAppStore.getInitialState()
const editorModes: readonly EditorToggleValue[] = ['edit', 'plugin-editor:demo/view', 'changes']

type HarnessProps = {
  ownerKey: string
  initialValue: EditorToggleValue
  modes?: readonly EditorToggleValue[]
  enabled?: boolean
}

function Harness({
  ownerKey,
  initialValue,
  modes = editorModes,
  enabled = true
}: HarnessProps): JSX.Element {
  const [value, setValue] = useState(initialValue)
  const panelRef = useRef<HTMLDivElement>(null)

  return (
    <div ref={panelRef} data-testid="panel">
      <output data-testid="mode">{value}</output>
      <button data-testid="inside" type="button">
        Editor
      </button>
      <EditorViewCommands
        viewSwitch={{ ownerKey, setApply: () => {}, handleChange: setValue }}
        enabled={enabled}
        panelRef={panelRef}
        applyToggle={() => {}}
        value={value}
        modes={modes}
      />
    </div>
  )
}

function dispatchKey(
  target: EventTarget,
  key: string,
  code: string,
  init: KeyboardEventInit & { defaultPrevented?: boolean } = {}
): KeyboardEvent {
  const { defaultPrevented = false, ...keyboardInit } = init
  const event = new KeyboardEvent('keydown', {
    key,
    code,
    bubbles: true,
    cancelable: true,
    ctrlKey: true,
    altKey: true,
    ...keyboardInit
  })
  if (defaultPrevented) {
    event.preventDefault()
  }
  target.dispatchEvent(event)
  return event
}

describe('EditorViewCommands', () => {
  let container: HTMLDivElement
  let root: Root
  let didUnmount = false

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    useAppStore.setState(initialState, true)
    didUnmount = false
    useAppStore.setState({
      keybindings: {
        'editor.toggleChanges': ['Ctrl+Alt+C'],
        'editor.cycleViewMode': ['Ctrl+Alt+V']
      } satisfies typeof initialState.keybindings
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    if (!didUnmount) {
      await act(async () => root.unmount())
    }
    document.body.replaceChildren()
    useAppStore.setState(initialState, true)
    vi.restoreAllMocks()
  })

  async function render(props: HarnessProps): Promise<void> {
    await act(async () => root.render(<Harness {...props} />))
  }

  function mode(): string | null {
    return container.querySelector('[data-testid="mode"]')?.textContent ?? null
  }

  function insideTarget(): HTMLButtonElement {
    const target = container.querySelector<HTMLButtonElement>('[data-testid="inside"]')
    if (!target) {
      throw new Error('missing editor target')
    }
    return target
  }

  it('cycles in the offered order and wraps, including plugin editor modes', async () => {
    await render({ ownerKey: 'local:wt:file:view', initialValue: 'edit' })

    await act(async () => dispatchKey(insideTarget(), 'v', 'KeyV'))
    expect(mode()).toBe('plugin-editor:demo/view')
    await act(async () => dispatchKey(insideTarget(), 'v', 'KeyV'))
    expect(mode()).toBe('changes')
    await act(async () => dispatchKey(insideTarget(), 'v', 'KeyV'))
    expect(mode()).toBe('edit')
  })

  it('toggles Changes back to the actual preceding mode', async () => {
    await render({
      ownerKey: 'local:wt:file:view',
      initialValue: 'plugin-editor:demo/view'
    })

    await act(async () => dispatchKey(insideTarget(), 'c', 'KeyC'))
    expect(mode()).toBe('changes')
    await act(async () => dispatchKey(insideTarget(), 'c', 'KeyC'))
    expect(mode()).toBe('plugin-editor:demo/view')
  })

  it('does nothing when Changes is not among the offered modes', async () => {
    await render({
      ownerKey: 'local:wt:file:view',
      initialValue: 'edit',
      modes: ['edit', 'plugin-editor:demo/view']
    })

    const event = await act(async () => dispatchKey(insideTarget(), 'c', 'KeyC'))
    expect(mode()).toBe('edit')
    expect(event.defaultPrevented).toBe(false)
  })

  it('uses the first offered non-Changes mode when the remembered mode is unavailable', async () => {
    await render({
      ownerKey: 'local:wt:file:view',
      initialValue: 'changes',
      modes: ['plugin-editor:demo/view', 'edit', 'changes']
    })

    await act(async () => dispatchKey(insideTarget(), 'c', 'KeyC'))
    expect(mode()).toBe('plugin-editor:demo/view')
  })

  it('resets the remembered mode when the owner identity changes', async () => {
    await render({ ownerKey: 'local:wt:file-a:view', initialValue: 'plugin-editor:demo/view' })
    await act(async () => dispatchKey(insideTarget(), 'c', 'KeyC'))
    expect(mode()).toBe('changes')

    await render({ ownerKey: 'environment:remote:wt:file-b:view', initialValue: 'edit' })
    await act(async () => dispatchKey(insideTarget(), 'c', 'KeyC'))
    expect(mode()).toBe('edit')
    await act(async () => dispatchKey(insideTarget(), 'c', 'KeyC'))
    expect(mode()).toBe('changes')
  })

  it('ignores events outside its panel and disabled non-owner panels', async () => {
    await render({ ownerKey: 'local:wt:file:view', initialValue: 'edit' })
    const recorder = document.createElement('button')
    recorder.dataset.shortcutRecorderActive = ''
    document.body.appendChild(recorder)
    const outsideEvent = await act(async () => dispatchKey(recorder, 'v', 'KeyV'))
    expect(mode()).toBe('edit')
    expect(outsideEvent.defaultPrevented).toBe(false)

    await render({ ownerKey: 'local:wt:file:view', initialValue: 'edit', enabled: false })
    const disabledEvent = await act(async () => dispatchKey(insideTarget(), 'v', 'KeyV'))
    expect(mode()).toBe('edit')
    expect(disabledEvent.defaultPrevented).toBe(false)
  })

  it('consumes matched repeats without repeating the transition', async () => {
    await render({ ownerKey: 'local:wt:file:view', initialValue: 'edit' })

    const event = await act(async () => dispatchKey(insideTarget(), 'v', 'KeyV', { repeat: true }))
    expect(event.defaultPrevented).toBe(true)
    expect(mode()).toBe('edit')
  })

  it.each([
    ['composing text', { isComposing: true }],
    ['the IME Process key', { key: 'Process' }],
    ['an already prevented event', { defaultPrevented: true }]
  ])('ignores %s', async (_label, init) => {
    await render({ ownerKey: 'local:wt:file:view', initialValue: 'edit' })

    const event = await act(async () => dispatchKey(insideTarget(), 'v', 'KeyV', init))
    expect(mode()).toBe('edit')
    expect(event.defaultPrevented).toBe('defaultPrevented' in init ? init.defaultPrevented : false)
  })

  it('uses changed bindings and unregisters its listener on unmount', async () => {
    await render({ ownerKey: 'local:wt:file:view', initialValue: 'edit' })

    const oldBinding = await act(async () => dispatchKey(insideTarget(), 'v', 'KeyV'))
    expect(oldBinding.defaultPrevented).toBe(true)
    expect(mode()).toBe('plugin-editor:demo/view')

    await act(async () =>
      useAppStore.setState({ keybindings: { 'editor.cycleViewMode': ['Ctrl+Alt+N'] } })
    )
    const oldChord = await act(async () => dispatchKey(insideTarget(), 'v', 'KeyV'))
    expect(oldChord.defaultPrevented).toBe(false)
    expect(mode()).toBe('plugin-editor:demo/view')
    const newChord = await act(async () => dispatchKey(insideTarget(), 'n', 'KeyN'))
    expect(newChord.defaultPrevented).toBe(true)
    expect(mode()).toBe('changes')

    const removeSpy = vi.spyOn(keyboardRouter, 'removeAppKeyListener')
    await act(async () => root.unmount())
    didUnmount = true
    expect(removeSpy).toHaveBeenCalledWith('keydown', expect.any(Function))
  })
})
