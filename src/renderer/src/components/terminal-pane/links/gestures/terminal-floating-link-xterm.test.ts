// @vitest-environment happy-dom
import { Terminal } from '@xterm/xterm'
import { afterEach, expect, it, vi } from 'vitest'
import { installTerminalLinkPointerGesture } from './terminal-link-pointer-gesture'
import { installTerminalLinkPtyMouseSuppression } from './terminal-link-pty-mouse-suppression'

const disposables: { dispose: () => void }[] = []
afterEach(() => {
  for (const disposable of disposables.splice(0).toReversed()) {
    disposable.dispose()
  }
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it.each([false, true])(
  'claims an Alt link without PTY effects with mouse reporting=%s',
  async (mouseReporting) => {
    vi.stubGlobal('navigator', { userAgent: 'Linux', platform: 'Linux' })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: xterm only needs measureText in this DOM fixture.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: () => ({ width: 10 })
    } as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(20)
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(320)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 800,
      bottom: 120,
      width: 800,
      height: 120,
      toJSON: () => ({})
    })
    const container = document.createElement('div')
    document.body.append(container)
    const terminal = new Terminal({
      cols: 80,
      rows: 6,
      altClickMovesCursor: true,
      mouseEventsRequireAlt: true
    })
    terminal.open(container)
    disposables.push(terminal)
    await new Promise<void>((resolve) =>
      terminal.write(`hello world\r\n${mouseReporting ? '\x1b[?1000h\x1b[?1006h' : ''}`, resolve)
    )
    const gesture = installTerminalLinkPointerGesture(terminal)
    const suppression = installTerminalLinkPtyMouseSuppression(
      terminal,
      () => true,
      (event) => gesture.canRequestAction(event),
      (event) => gesture.canRequestAction(event)
    )
    disposables.push(gesture, suppression)
    const forwarded: string[] = []
    disposables.push(
      terminal.onData((data) => suppression.handlePtyInput(data, (data) => forwarded.push(data)))
    )
    const screen = terminal.element!.querySelector<HTMLElement>('.xterm-screen')!
    screen.style.padding = '0px'
    terminal.element!.style.padding = '0px'
    const mouse = (type: string, ctrlKey: boolean, clientX = 45, clientY = 10): void => {
      const event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons: type === 'mouseup' ? 0 : 1,
        clientX,
        clientY,
        altKey: true,
        ctrlKey,
        detail: 1
      })
      // happy-dom omits the modifier query that Chromium supplies to xterm's drag listener.
      Object.defineProperty(event, 'getModifierState', {
        value: (key: string) => key === 'Alt' || (key === 'Control' && ctrlKey)
      })
      screen.dispatchEvent(event)
    }
    terminal.element!.addEventListener('mouseup', (event) => {
      if (event.ctrlKey && gesture.canRequestAction(event)) {
        expect(suppression.claimAction()).toBe(true)
        event.preventDefault()
      }
    })
    mouse('mousedown', true)
    mouse('mouseup', true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(forwarded).toEqual([])
    expect(terminal.hasSelection()).toBe(false)
    mouse('mousedown', false)
    mouse('mouseup', false)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(forwarded.join('')).not.toBe('')
    forwarded.length = 0
    mouse('mousedown', true)
    mouse('mousemove', true, 95, 30)
    mouse('mouseup', true, 95, 30)
    await new Promise((resolve) => setTimeout(resolve, 0))
    if (mouseReporting) {
      expect(forwarded.join('')).not.toBe('')
    } else {
      expect(terminal.hasSelection()).toBe(true)
    }
  }
)
