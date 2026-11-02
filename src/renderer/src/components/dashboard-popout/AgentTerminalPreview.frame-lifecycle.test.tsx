// @vitest-environment happy-dom

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ITerminalOptions } from '@xterm/xterm'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import { useAppStore } from '@/store'
import { AgentTerminalPreview } from './AgentTerminalPreview'

type PreviewInstance = {
  options: ITerminalOptions
  container: HTMLElement | null
  dispose: ReturnType<typeof vi.fn>
  writeCallbacks: (() => void)[]
}
const harness = vi.hoisted(() => ({
  instances: new Array<PreviewInstance>(),
  deferWrites: false
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    buffer = { active: { cursorY: 14 } }
    container: HTMLElement | null = null
    screen = document.createElement('div')
    writeCallbacks: (() => void)[] = []
    write = vi.fn((_data: string, callback?: () => void) => {
      if (!callback) {
        return
      }
      if (harness.deferWrites) {
        this.writeCallbacks.push(callback)
      } else {
        callback()
      }
    })
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
const frames = new Map<number, FrameRequestCallback>()
let nextFrame = 0
const cancelFrame = vi.fn((id: number) => frames.delete(id))
function flushFrames(): void {
  for (const [id, callback] of frames) {
    frames.delete(id)
    callback(16)
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  harness.instances.length = 0
  harness.deferWrites = false
  frames.clear()
  nextFrame = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextFrame++
    frames.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', cancelFrame)
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
  frames.clear()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it('releases every frame after 64 actual preview unmounts', async () => {
  for (let index = 0; index < 64; index++) {
    const view = render(<AgentTerminalPreview ptyId={`ssh:host@@pty-${index}`} />)
    await act(async () => {})
    view.unmount()
  }
  expect(connect).toHaveBeenCalledTimes(64)
  expect(unsubscribe).toHaveBeenCalledTimes(64)
  expect(harness.instances).toHaveLength(64)
  for (const instance of harness.instances) {
    expect(instance.dispose).toHaveBeenCalledOnce()
  }
  expect(fit).not.toHaveBeenCalled()
  expect(frames.size).toBe(0)
  expect(cancelFrame).toHaveBeenCalledTimes(64)
  expect(cancelFrame).toHaveBeenCalledWith(0)
})

it('does not schedule an old parsed write after actual unmount', async () => {
  harness.deferWrites = true
  const view = render(<AgentTerminalPreview ptyId="ssh:host@@pty-late" />)
  await act(async () => {})
  const terminal = harness.instances[0]
  expect(terminal).toBeDefined()
  flushFrames()
  view.unmount()
  for (const callback of terminal?.writeCallbacks.splice(0) ?? []) {
    callback()
  }
  expect(connect).toHaveBeenCalledOnce()
  expect(unsubscribe).toHaveBeenCalledOnce()
  expect(terminal?.dispose).toHaveBeenCalledOnce()
  expect(frames.size).toBe(0)
})

it('retains the replacement frame on the same DOM and ignores retired parsed writes', async () => {
  harness.deferWrites = true
  render(<AgentTerminalPreview ptyId="pty-1" />)
  await act(async () => {})
  const old = harness.instances[0]
  await act(async () => useAppStore.getState().updateSettings({ terminalFontSize: 18 }))
  const replacement = harness.instances[1]
  const pending = frames.size
  for (const callback of old?.writeCallbacks.splice(0) ?? []) {
    callback()
  }
  const afterOldWrites = frames.size
  flushFrames()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200)
  })
  expect(connect).toHaveBeenCalledTimes(2)
  expect(unsubscribe).toHaveBeenCalledExactlyOnceWith('pty-1')
  expect(old?.dispose).toHaveBeenCalledOnce()
  expect(replacement?.container).toBe(old?.container)
  expect(replacement?.container?.style.transform).toBe('scale(0.625)')
  expect(replacement?.container?.style.transformOrigin).toBe('top left')
  expect(fit).toHaveBeenCalledExactlyOnceWith('pty-1', 50, 15)
  expect(frames.size).toBe(0)
  expect([pending, afterOldWrites]).toEqual([1, 1])
})

it('keeps live replay writes coalesced and fits the latest cursor and dimensions', async () => {
  harness.deferWrites = true
  render(<AgentTerminalPreview ptyId="pty-live" />)
  await act(async () => {})
  const terminal = harness.instances[0]
  for (const callback of terminal?.writeCallbacks.splice(0) ?? []) {
    callback()
  }
  expect(frames.size).toBe(1)
  flushFrames()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200)
  })
  expect(connect).toHaveBeenCalledOnce()
  expect(unsubscribe).not.toHaveBeenCalled()
  expect(terminal?.dispose).not.toHaveBeenCalled()
  expect(terminal?.container?.style.transform).toBe('scale(0.75)')
  expect(terminal?.container?.style.transformOrigin).toBe('top left')
  expect(fit).toHaveBeenCalledExactlyOnceWith('pty-live', 60, 15)
})
