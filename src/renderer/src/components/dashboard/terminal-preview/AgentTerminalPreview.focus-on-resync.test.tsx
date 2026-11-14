// @vitest-environment happy-dom

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ITerminalOptions } from '@xterm/xterm'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { createGlobalSettingsFixture } from '../../../../../shared/global-settings-test-fixture'
import { useAppStore } from '@/store'
import { AgentTerminalPreview } from './AgentTerminalPreview'

type PreviewInstance = {
  options: ITerminalOptions
  dispose: ReturnType<typeof vi.fn>
  focus: ReturnType<typeof vi.fn>
}
const harness = vi.hoisted(() => ({ instances: new Array<PreviewInstance>() }))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    buffer = { active: { cursorY: 14 } }
    screen = document.createElement('div')
    write = vi.fn((_data: string, callback?: () => void) => callback?.())
    focus = vi.fn()
    resize = vi.fn()
    reset = vi.fn()
    onData = vi.fn(() => ({ dispose: vi.fn() }))
    dispose = vi.fn(() => this.screen.remove())
    constructor(public options: ITerminalOptions) {
      harness.instances.push(this)
    }
    open(container: HTMLElement): void {
      this.screen.className = 'xterm-screen'
      Object.defineProperties(this.screen, {
        offsetWidth: { get: () => this.cols * 10 },
        offsetHeight: { get: () => this.rows * 16 }
      })
      const box = container.parentElement
      if (!box) {
        throw new Error('Missing preview box')
      }
      Object.defineProperties(box, {
        clientWidth: { configurable: true, value: 600 },
        clientHeight: { configurable: true, value: 240 }
      })
      container.append(this.screen)
    }
  }
}))
vi.mock('@/components/terminal-pane/input/terminal-user-input-signal', () => ({
  subscribeToTerminalUserInput: () => ({ dispose: vi.fn() })
}))
vi.mock('@/hooks/theme/use-system-prefers-dark', () => ({
  useSystemPrefersDark: () => false
}))
vi.mock('@/lib/keyboard-layout/use-effective-mac-option-as-alt', () => ({
  useEffectiveMacOptionAsAlt: (value: string) => value
}))
vi.mock('@/components/standalone-terminal/rendering/preview-terminal-ligatures', () => ({
  syncPreviewTerminalLigatures: vi.fn()
}))
vi.mock('@/components/standalone-terminal/rendering/preview-terminal-compatibility', () => ({
  installPreviewTerminalCompatibility: () => vi.fn()
}))
vi.mock('@/components/standalone-terminal/input/preview-terminal-ime-bridge', () => ({
  installPreviewImeBridge: () => ({ claimKeyEvent: () => false, dispose: vi.fn() })
}))
vi.mock('@/components/standalone-terminal/input/preview-terminal-key-handler', () => ({
  installPreviewTerminalKeyHandler: () => vi.fn()
}))
vi.mock('@/components/terminal-pane/clipboard/terminal-native-copy-gutter', () => ({
  installTerminalNativeCopyGutterTrim: () => ({ dispose: vi.fn() })
}))
vi.mock('@/components/standalone-terminal/input/preview-terminal-app-menu-clipboard', () => ({
  installPreviewTerminalAppMenuClipboard: () => vi.fn()
}))
vi.mock('@/components/standalone-terminal/input/preview-terminal-right-click-paste', () => ({
  installPreviewTerminalRightClickPaste: () => vi.fn()
}))

const initial = useAppStore.getInitialState()
const connect = vi.fn<Window['api']['terminalPreview']['connect']>()
const fit = vi.fn(async (_ptyId: string, cols: number, rows: number) => ({ cols, rows }))
const unsubscribe = vi.fn(async () => {})
let deliver: Parameters<Window['api']['terminalPreview']['onData']>[0] = () => {}
let originalApi: PropertyDescriptor | undefined

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  harness.instances.length = 0
  vi.stubGlobal('requestAnimationFrame', () => 0)
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn()
      disconnect = vi.fn()
    }
  )
  const settings: GlobalSettings = createGlobalSettingsFixture({
    theme: 'dark',
    activeRuntimeEnvironmentId: null,
    terminalLigatures: 'off'
  })
  connect
    .mockReset()
    .mockResolvedValue({ snapshot: { data: '', cols: 80, rows: 24, seq: 1 }, replay: [] })
  originalApi = Object.getOwnPropertyDescriptor(window, 'api')
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      settings: { set: async () => settings },
      terminalPreview: {
        connect,
        fit,
        unsubscribe,
        onData: (listener: typeof deliver) => {
          deliver = listener
          return vi.fn()
        }
      }
    }
  })
  useAppStore.setState({ ...initial, settings }, true)
})

afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
  if (originalApi) {
    Object.defineProperty(window, 'api', originalApi)
  } else {
    Reflect.deleteProperty(window, 'api')
  }
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it('a resync takes focus unless focusOnResync is false; the first replay always does', async () => {
  const quiet = render(<AgentTerminalPreview ptyId="pty-1" focusOnResync={false} />)
  await act(async () => {})
  await act(async () => deliver({ type: 'resync', ptyId: 'pty-1' }))
  expect(connect).toHaveBeenCalledTimes(2)
  expect(harness.instances[0]?.focus).toHaveBeenCalledOnce()
  quiet.unmount()
  render(<AgentTerminalPreview ptyId="pty-1" />)
  await act(async () => {})
  await act(async () => deliver({ type: 'resync', ptyId: 'pty-1' }))
  expect(harness.instances[1]?.focus).toHaveBeenCalledTimes(2)
})
