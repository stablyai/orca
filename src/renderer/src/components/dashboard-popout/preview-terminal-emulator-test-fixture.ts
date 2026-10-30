import { vi } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import { installTerminalLinkPtyMouseSuppression } from '../terminal-pane/terminal-link-pty-mouse-suppression'

type PreviewCurrentLink = {
  linkifier: {
    _currentLink: {
      link: {
        text: string
        range: { start: { x: number; y: number }; end: { x: number; y: number } }
      }
    } | null
  }
}
type PreviewTerminalHarness = {
  instances: PreviewTestTerminal[]
  userInputListener: (() => void) | null
}
export class PreviewTestTerminal {
  options: Terminal['options'] = {}
  cols = 80
  rows = 24
  buffer = { active: { cursorY: 0, viewportY: 0 } }
  _core: PreviewCurrentLink = {
    linkifier: { _currentLink: null }
  }
  writeCallbacks: (() => void)[] = []
  onDataListener: ((data: string) => void) | null = null
  customKeyHandler: ((event: KeyboardEvent) => boolean) | null = null
  selectionText = ''
  write = vi.fn((_data: string, callback?: () => void) => {
    if (callback) {
      this.writeCallbacks.push(callback)
    }
  })
  open = vi.fn((host: HTMLElement) => host.append(this.element))
  focus = vi.fn()
  dispose = vi.fn()
  resize = vi.fn()
  reset = vi.fn()
  modes = { bracketedPasteMode: false }
  paste = vi.fn((data: string) => {
    this.harness.userInputListener?.()
    this.onDataListener?.(data)
  })
  input = vi.fn((data: string) => {
    this.harness.userInputListener?.()
    this.onDataListener?.(data)
  })
  element = document.createElement('div')
  unicode = { activeVersion: '6', versions: ['6', '11'], register: vi.fn() }
  loadAddon = vi.fn()
  attachCustomWheelEventHandler = vi.fn()
  scrollToTop = vi.fn()
  scrollToBottom = vi.fn()
  selectAll = vi.fn()
  clearSelection = vi.fn()
  getSelection = vi.fn(() => this.selectionText)
  hasSelection = vi.fn(() => this.selectionText !== '')
  attachCustomKeyEventHandler = vi.fn((handler: (event: KeyboardEvent) => boolean) => {
    this.customKeyHandler = handler
  })
  onData = vi.fn((listener: (data: string) => void) => {
    this.onDataListener = listener
    return { dispose: vi.fn() }
  })

  constructor(private readonly harness: PreviewTerminalHarness) {
    const screen = document.createElement('div')
    screen.className = 'xterm-screen'
    screen.getBoundingClientRect = () => new DOMRect(0, 0, 800, 240)
    this.element.append(screen)
    this.harness.instances.push(this)
  }
}

export function previewContext(
  terminal: PreviewTestTerminal,
  url: string,
  origin: 'matching' | 'absent' | 'no-link' = 'matching'
): void {
  const range = { start: { x: 1, y: 1 }, end: { x: 60, y: 1 } }
  terminal._core.linkifier._currentLink =
    origin === 'no-link' ? null : { link: { text: url, range } }
  terminal.options.linkHandler?.hover?.(new MouseEvent('mousemove'), url, range)
  const facts = {
    bubbles: true,
    cancelable: true,
    button: 2,
    buttons: 2,
    clientX: 5,
    clientY: 5,
    screenX: 5,
    screenY: 5
  }
  const down = new MouseEvent('mousedown', facts)
  if (origin !== 'absent') {
    terminal.element.dispatchEvent(down)
  }
  const menu = new MouseEvent('contextmenu', facts)
  Object.defineProperty(menu, 'timeStamp', { value: down.timeStamp })
  terminal.element.dispatchEvent(menu)
  terminal.element.dispatchEvent(new MouseEvent('mouseup', { ...facts, buttons: 0 }))
}

/** Geometry/lifetime specs omit compatibility addons, while retaining the required owner contract. */
export function createPreviewCompatibilityTestDisposer(
  terminal: Parameters<typeof installTerminalLinkPtyMouseSuppression>[0]
) {
  const inputOwner = installTerminalLinkPtyMouseSuppression(terminal, {
    candidate: () => null,
    eligible: () => false,
    canContinue: () => false
  })
  return Object.assign(() => inputOwner.dispose(), { inputOwner })
}
