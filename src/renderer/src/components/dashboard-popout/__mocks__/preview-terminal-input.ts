import { vi } from 'vitest'

vi.mock('../preview-terminal-links', () => ({
  installPreviewTerminalLinks: () => vi.fn()
}))

type Mock = ReturnType<typeof vi.fn>
type PreviewTestTerminal = {
  write: Mock
  writeCallbacks: (() => void)[]
  onDataListener: ((data: string) => void) | null
  dispose: Mock
  resize: Mock
  reset: Mock
  paste: Mock
  input: Mock
  scrollToTop: Mock
  scrollToBottom: Mock
  selectAll: Mock
  modes: { bracketedPasteMode: boolean }
  selectionText: string
  customKeyHandler: ((event: KeyboardEvent) => boolean) | null
}

type ImeForwarder = {
  claimKeyEvent: Mock
  dispose: Mock
  sendInput: (data: string) => void
  getKittyKeyboardFlags: () => number
}

const terminalHarness = vi.hoisted(
  (): {
    instances: PreviewTestTerminal[]
    userInputListeners: WeakMap<PreviewTestTerminal, () => void>
    userInputDispose: Mock
  } => {
    const instances: PreviewTestTerminal[] = []
    return {
      instances,
      userInputListeners: new WeakMap<PreviewTestTerminal, () => void>(),
      userInputDispose: vi.fn()
    }
  }
)

const platformState = vi.hoisted(() => ({ value: 'linux' }))
const storeState = vi.hoisted(
  (): {
    settings: { terminalRightClickToPaste?: boolean } | null
    keybindings: Record<string, string[]>
  } => ({ settings: null, keybindings: {} })
)

const imeHarness = vi.hoisted(() => {
  const forwarders: ImeForwarder[] = []
  const trackers: { dispose: Mock }[] = []
  return { forwarders, trackers, claimResult: false }
})

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    buffer = { active: { cursorY: 0 } }
    writeCallbacks: (() => void)[] = []
    onDataListener: ((data: string) => void) | null = null
    customKeyHandler: ((event: KeyboardEvent) => boolean) | null = null
    selectionText = ''
    write = vi.fn((_data: string, callback?: () => void) => {
      if (callback) {
        this.writeCallbacks.push(callback)
      }
    })
    open = vi.fn()
    focus = vi.fn()
    dispose = vi.fn()
    resize = vi.fn()
    reset = vi.fn()
    modes = { bracketedPasteMode: false }
    paste = vi.fn((data: string) => {
      terminalHarness.userInputListeners.get(this)?.()
      this.onDataListener?.(data)
    })
    input = vi.fn((data: string) => {
      terminalHarness.userInputListeners.get(this)?.()
      this.onDataListener?.(data)
    })
    element = document.createElement('div')
    unicode = { activeVersion: '6', versions: ['6', '11'], register: vi.fn() }
    loadAddon = vi.fn()
    attachCustomWheelEventHandler = vi.fn()
    scrollToTop = vi.fn()
    scrollToBottom = vi.fn()
    selectAll = vi.fn()
    getSelection = vi.fn(() => this.selectionText)
    attachCustomKeyEventHandler = vi.fn((handler: (event: KeyboardEvent) => boolean) => {
      this.customKeyHandler = handler
    })
    onData = vi.fn((listener: (data: string) => void) => {
      this.onDataListener = listener
      return { dispose: vi.fn() }
    })

    constructor() {
      terminalHarness.instances.push(this)
    }
  }
}))
vi.mock(import('@/lib/pane-manager/pane-terminal-options'), async (importOriginal) => ({
  ...(await importOriginal()),
  buildDefaultTerminalOptions: () => ({})
}))
vi.mock('@/components/terminal-pane/terminal-user-input-signal', () => ({
  subscribeToTerminalUserInput: (terminal: PreviewTestTerminal, listener: () => void) => {
    terminalHarness.userInputListeners.set(terminal, listener)
    return { dispose: terminalHarness.userInputDispose }
  }
}))
vi.mock('@/components/terminal-pane/use-system-prefers-dark', () => ({
  useSystemPrefersDark: () => false
}))
vi.mock('@/lib/shortcut-platform', () => ({
  getShortcutPlatform: () => platformState.value
}))
vi.mock('@/components/terminal-pane/terminal-ime-native-text-forwarder', () => ({
  installTerminalImeNativeTextForwarder: (args: {
    sendInput: (data: string) => void
    getKittyKeyboardFlags?: () => number
  }) => {
    const forwarder = {
      claimKeyEvent: vi.fn(() => imeHarness.claimResult),
      dispose: vi.fn(),
      sendInput: args.sendInput,
      // Why captured: the bridge's whole job is handing the live mirror to the
      // forwarder, so the test reads what a real commit would read.
      getKittyKeyboardFlags: args.getKittyKeyboardFlags ?? ((): number => 0)
    }
    imeHarness.forwarders.push(forwarder)
    return forwarder
  }
}))
vi.mock('@/components/terminal-pane/terminal-ime-composition-tracker', () => ({
  installTerminalImeCompositionTracker: () => {
    const tracker = { isActive: () => false, dispose: vi.fn() }
    imeHarness.trackers.push(tracker)
    return tracker
  }
}))
vi.mock('@/store', () => {
  const useAppStore = (selector: (s: typeof storeState) => unknown): unknown => selector(storeState)
  useAppStore.getState = (): typeof storeState => storeState
  return { useAppStore }
})

export { terminalHarness, platformState, storeState, imeHarness }
