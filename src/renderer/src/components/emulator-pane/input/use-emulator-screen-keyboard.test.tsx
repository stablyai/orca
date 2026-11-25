// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useEmulatorScreenKeyboard } from './use-emulator-screen-keyboard'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: vi.fn() }))

const scrcpyKeyboard = {
  sendKey: vi.fn(),
  sendText: vi.fn(async () => true),
  pasteText: vi.fn(async () => true)
}

function AndroidPane(): React.JSX.Element {
  const { handleKeyDown } = useEmulatorScreenKeyboard({
    cancelKeyboardFrames: () => {},
    canInteract: true,
    scrcpyKeyboard,
    sendKeyboardFrames: () => true,
    worktreeId: 'wt-1'
  })
  return <div aria-label="screen" tabIndex={0} onKeyDown={handleKeyDown} />
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('api', { app: { onKeyboardLayoutChanged: () => () => undefined } })
  vi.clearAllMocks()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root.render(<AndroidPane />))
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

function press(init: { key: string; altKey?: boolean; ctrlKey?: boolean; altGraph?: boolean }) {
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    key: init.key,
    altKey: init.altKey ?? false,
    ctrlKey: init.ctrlKey ?? false
  })
  Object.defineProperty(event, 'getModifierState', {
    value: (key: string) => key === 'AltGraph' && init.altGraph === true
  })
  act(() => {
    container.querySelector('[aria-label="screen"]')!.dispatchEvent(event)
  })
}

describe('Android emulator pane keys', () => {
  it('sends any character the host layout produced as text, and leaves shortcuts to Orca', () => {
    press({ key: 'Enter' })
    press({ key: 'ş' })
    press({ key: '中' })
    // AltGr arrives as Ctrl+Alt on Windows and Linux and composes characters such as "€".
    press({ key: '€', altKey: true, ctrlKey: true, altGraph: true })
    press({ key: 'Backspace' })
    // Plain Alt and Ctrl combinations off a Mac stay shortcuts.
    press({ key: 'c', altKey: true })
    press({ key: 'c', ctrlKey: true })

    expect(scrcpyKeyboard.sendText.mock.calls).toEqual([['ş'], ['中'], ['€']])
    expect(scrcpyKeyboard.sendKey).toHaveBeenCalledWith('backspace', false)
  })

  it('sends Mac Option characters as text', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0)' })
    press({ key: 'Enter' })
    // German Option+L types "@".
    press({ key: '@', altKey: true })

    expect(scrcpyKeyboard.sendText.mock.calls).toEqual([['@']])
  })
})

describe('iOS simulator pane keys', () => {
  it('drops keys buffered for a capture that ended before its layout sync finished', async () => {
    const { callRuntimeRpc } = await import('@/runtime/rpc/calls/runtime-rpc-call')
    const replies: (() => void)[] = []
    vi.mocked(callRuntimeRpc).mockImplementation(
      () =>
        new Promise((resolve) => {
          replies.push(() => resolve({ physicalKeys: true }))
        })
    )
    const sent: number[] = []
    function IosPane(): React.JSX.Element {
      const { handleKeyDown, enableKeyboardCapture } = useEmulatorScreenKeyboard({
        cancelKeyboardFrames: () => {},
        canInteract: true,
        scrcpyKeyboard: null,
        sendKeyboardFrames: (frames) => {
          sent.push(frames.length)
          return true
        },
        worktreeId: 'wt-1'
      })
      return (
        <div
          aria-label="ios"
          tabIndex={0}
          onKeyDown={handleKeyDown}
          onFocus={enableKeyboardCapture}
        />
      )
    }
    act(() => root.render(<IosPane />))
    const screen = container.querySelector<HTMLDivElement>('[aria-label="ios"]')!
    const key = (init: KeyboardEventInit) =>
      act(() => {
        const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
        Object.defineProperty(event, 'getModifierState', { value: () => false })
        screen.dispatchEvent(event)
      })

    key({ key: 'Enter', code: 'Enter' })
    key({ key: 'a', code: 'KeyA' })
    key({ key: 'Escape', code: 'Escape' })
    key({ key: 'Enter', code: 'Enter' })
    key({ key: 'b', code: 'KeyB' })
    await act(async () => {
      replies.forEach((resolve) => resolve())
    })

    expect(sent).toEqual([2])
  })
})
