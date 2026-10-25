// @vitest-environment happy-dom

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ITerminalOptions } from '@xterm/xterm'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { TerminalPreviewConnectResult } from '../../../../shared/terminal-preview'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import { useAppStore } from '@/store'
import { AgentTerminalPreview } from './AgentTerminalPreview'

type PreviewInstance = {
  options: ITerminalOptions
  container: HTMLElement | null
  dispose: ReturnType<typeof vi.fn>
}
const harness = vi.hoisted(() => ({ instances: new Array<PreviewInstance>() }))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    buffer = { active: { cursorY: 14 } }
    container: HTMLElement | null = null
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
      this.container = container
      this.screen.className = 'xterm-screen'
      Object.defineProperties(this.screen, {
        offsetWidth: {
          get: () =>
            this.cols *
            (this.options.fontSize === 18 ||
            this.options.fontFamily?.includes('Fira Code') ||
            this.options.fontWeight === 900 ||
            this.options.fontWeightBold === 900
              ? 12
              : 10)
        },
        offsetHeight: { get: () => this.rows * 16 * (this.options.lineHeight ?? 1) }
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
vi.mock('@/components/terminal-pane/terminal-user-input-signal', () => ({
  subscribeToTerminalUserInput: () => ({ dispose: vi.fn() })
}))
vi.mock('@/components/terminal-pane/use-system-prefers-dark', () => ({
  useSystemPrefersDark: () => false
}))
vi.mock('@/lib/keyboard-layout/use-effective-mac-option-as-alt', () => ({
  useEffectiveMacOptionAsAlt: (value: string) => value
}))
vi.mock('./preview-terminal-ligatures', () => ({ syncPreviewTerminalLigatures: vi.fn() }))
vi.mock('./preview-terminal-compatibility', () => ({
  installPreviewTerminalCompatibility: () => vi.fn()
}))
vi.mock('./preview-terminal-ime-bridge', () => ({
  installPreviewImeBridge: () => ({ claimKeyEvent: () => false, dispose: vi.fn() })
}))
vi.mock('./preview-terminal-key-handler', () => ({
  installPreviewTerminalKeyHandler: () => vi.fn()
}))
vi.mock('@/components/terminal-pane/terminal-native-copy-gutter', () => ({
  installTerminalNativeCopyGutterTrim: () => ({ dispose: vi.fn() })
}))
vi.mock('./preview-terminal-app-menu-clipboard', () => ({
  installPreviewTerminalAppMenuClipboard: () => vi.fn()
}))
vi.mock('./preview-terminal-right-click-paste', () => ({
  installPreviewTerminalRightClickPaste: () => vi.fn()
}))

const initial = useAppStore.getInitialState()
const connect = vi.fn<Window['api']['terminalPreview']['connect']>()
const fit = vi.fn(async (_ptyId: string, cols: number, rows: number) => ({ cols, rows }))
const unsubscribe = vi.fn(async () => {})
let settings: GlobalSettings
let originalApi: PropertyDescriptor | undefined

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  harness.instances.length = 0
  // No resize notification or later output: replay must perform its own fit and grid claim.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn()
      disconnect = vi.fn()
    }
  )
  settings = createGlobalSettingsFixture({
    theme: 'dark',
    activeRuntimeEnvironmentId: null,
    terminalFontSize: 14,
    terminalFontFamily: 'JetBrains Mono',
    terminalFontWeight: 500,
    terminalFontWeightBold: 700,
    terminalLineHeight: 1,
    terminalLigatures: 'off'
  })
  connect
    .mockReset()
    .mockResolvedValue({ snapshot: { data: '', cols: 80, rows: 24, seq: 1 }, replay: [] })
  originalApi = Object.getOwnPropertyDescriptor(window, 'api')
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      settings: {
        set: async (updates: Partial<GlobalSettings>) => {
          settings = structuredClone({ ...settings, ...updates })
          return settings
        }
      },
      terminalPreview: { connect, fit, unsubscribe, onData: () => vi.fn() }
    }
  })
  useAppStore.setState({ ...initial, settings }, true)
})

afterEach(() => {
  cleanup()
  for (const instance of harness.instances) {
    expect(instance.dispose).toHaveBeenCalledOnce()
  }
  useAppStore.setState(initial, true)
  if (originalApi) {
    Object.defineProperty(window, 'api', originalApi)
  } else {
    Reflect.deleteProperty(window, 'api')
  }
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

async function settleGeometry(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250)
  })
}

it.each([
  {
    updates: { terminalFontSize: 18 },
    cols: 50,
    rows: 15,
    scale: 'scale(0.625)',
    anchor: 'top left'
  },
  {
    updates: { terminalFontFamily: 'Fira Code' },
    cols: 50,
    rows: 15,
    scale: 'scale(0.625)',
    anchor: 'top left'
  },
  {
    updates: { terminalFontWeight: 900 },
    cols: 50,
    rows: 15,
    scale: 'scale(0.625)',
    anchor: 'top left'
  },
  {
    updates: { terminalFontWeightBold: 900 },
    cols: 50,
    rows: 15,
    scale: 'scale(0.625)',
    anchor: 'top left'
  },
  {
    updates: { terminalLineHeight: 1.5 },
    cols: 60,
    rows: 10,
    scale: 'scale(0.75)',
    anchor: 'bottom left'
  },
  {
    updates: { terminalLigatures: 'on' },
    cols: 60,
    rows: 15,
    scale: 'scale(0.75)',
    anchor: 'top left'
  }
] satisfies {
  updates: Partial<GlobalSettings>
  cols: number
  rows: number
  scale: string
  anchor: string
}[])(
  'recreates the owner and fits the new geometry for $updates',
  async ({ updates, cols, rows, scale, anchor }) => {
    render(<AgentTerminalPreview ptyId="pty-1" />)
    await settleGeometry()
    expect(fit).toHaveBeenLastCalledWith('pty-1', 60, 15)
    await act(async () => useAppStore.getState().updateSettings(updates))
    await settleGeometry()

    expect(fit).toHaveBeenCalledTimes(2)
    expect(fit).toHaveBeenLastCalledWith('pty-1', cols, rows)
    expect(harness.instances).toHaveLength(2)
    expect(connect).toHaveBeenCalledTimes(2)
    expect(unsubscribe).toHaveBeenCalledExactlyOnceWith('pty-1')
    expect(harness.instances[1]?.container?.style.transform).toBe(scale)
    expect(harness.instances[1]?.container?.style.transformOrigin).toBe(anchor)
  }
)

it('ignores a pending connection retired by a metric change', async () => {
  const gate = Promise.withResolvers<TerminalPreviewConnectResult>()
  connect.mockReturnValueOnce(gate.promise)
  render(<AgentTerminalPreview ptyId="pty-1" />)
  await act(async () => useAppStore.getState().updateSettings({ terminalFontSize: 18 }))
  await settleGeometry()
  await act(async () =>
    gate.resolve({ snapshot: { data: '', cols: 80, rows: 24, seq: 1 }, replay: [] })
  )
  await settleGeometry()
  expect(connect).toHaveBeenCalledTimes(2)
  expect(harness.instances).toHaveLength(1)
  expect(harness.instances[0]?.options.fontSize).toBe(18)
  expect(fit).toHaveBeenCalledExactlyOnceWith('pty-1', 50, 15)
})

it('cancels an obsolete metric owner grid claim before the next change', async () => {
  render(<AgentTerminalPreview ptyId="pty-1" />)
  await settleGeometry()
  await act(async () => useAppStore.getState().updateSettings({ terminalFontSize: 18 }))
  await act(async () => useAppStore.getState().updateSettings({ terminalLineHeight: 1.5 }))
  await settleGeometry()
  expect(harness.instances).toHaveLength(3)
  expect(fit).toHaveBeenCalledTimes(2)
  expect(fit).toHaveBeenLastCalledWith('pty-1', 50, 10)
})
