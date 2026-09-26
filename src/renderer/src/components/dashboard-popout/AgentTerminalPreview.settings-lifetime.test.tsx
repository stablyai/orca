// @vitest-environment happy-dom

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ITerminalOptions } from '@xterm/xterm'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { TerminalPreviewConnectResult } from '../../../../shared/terminal-preview'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import { makeCustomTerminalThemeSelection } from '../../../../shared/terminal-custom-themes'
import { useAppStore } from '@/store'
import { AgentTerminalPreview } from './AgentTerminalPreview'

type PreviewInstance = {
  options: ITerminalOptions
  dispose: ReturnType<typeof vi.fn>
  reset: ReturnType<typeof vi.fn>
}

const harness = vi.hoisted(() => ({
  instances: new Array<PreviewInstance>(),
  systemPrefersDark: false
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    buffer = { active: { cursorY: 0 } }
    options: ITerminalOptions
    write = vi.fn((_data: string, callback?: () => void) => callback?.())
    open = vi.fn()
    focus = vi.fn()
    dispose = vi.fn()
    resize = vi.fn()
    reset = vi.fn()
    onData = vi.fn(() => ({ dispose: vi.fn() }))
    constructor(options: ITerminalOptions) {
      this.options = options
      harness.instances.push(this)
    }
  }
}))
vi.mock('@/components/terminal-pane/terminal-user-input-signal', () => ({
  subscribeToTerminalUserInput: () => ({ dispose: vi.fn() })
}))
vi.mock('@/components/terminal-pane/use-system-prefers-dark', () => ({
  useSystemPrefersDark: () => harness.systemPrefersDark
}))
vi.mock('@/lib/keyboard-layout/use-effective-mac-option-as-alt', () => ({
  useEffectiveMacOptionAsAlt: (value: string) => value
}))
vi.mock('./preview-grid-claim', () => ({
  createPreviewGridClaim: () => ({ schedule: vi.fn(), dispose: vi.fn() })
}))
vi.mock('./preview-terminal-box-fit', () => ({
  createPreviewBoxFit: () => ({ schedule: vi.fn() })
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
const unsubscribe = vi.fn(async () => {})
const offData = vi.fn()
const onData = vi.fn((listener: Parameters<Window['api']['terminalPreview']['onData']>[0]) => {
  emitData = listener
  return offData
})
const connection: TerminalPreviewConnectResult = {
  snapshot: { data: 'agent prompt', cols: 80, rows: 24, seq: 1 },
  replay: []
}
let settings: GlobalSettings
let originalApi: PropertyDescriptor | undefined
let emitData: Parameters<Window['api']['terminalPreview']['onData']>[0] | undefined

async function updateSettings(updates: Partial<GlobalSettings>): Promise<void> {
  await act(async () => useAppStore.getState().updateSettings(updates))
}

function terminal(index = 0): PreviewInstance {
  const instance = harness.instances[index]
  if (!instance) {
    throw new Error(`Missing terminal ${index}`)
  }
  return instance
}

beforeEach(() => {
  vi.clearAllMocks()
  harness.instances.length = 0
  harness.systemPrefersDark = false
  emitData = undefined
  settings = createGlobalSettingsFixture({ theme: 'dark', activeRuntimeEnvironmentId: null })
  connect.mockReset().mockResolvedValue(connection)
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
      terminalPreview: {
        connect,
        unsubscribe,
        onData
      }
    }
  })
  useAppStore.setState({ ...initial, settings }, true)
})

afterEach(() => {
  cleanup()
  for (const instance of harness.instances) {
    expect(instance.dispose).toHaveBeenCalledOnce()
  }
  expect(offData).toHaveBeenCalledTimes(onData.mock.calls.length)
  useAppStore.setState(initial, true)
  if (originalApi) {
    Object.defineProperty(window, 'api', originalApi)
  } else {
    Reflect.deleteProperty(window, 'api')
  }
})

describe('preview terminal settings lifetime', () => {
  it('keeps one preview connection across ten unrelated settings snapshots', async () => {
    render(<AgentTerminalPreview ptyId="pty-1" />)
    await act(async () => {})
    const theme = terminal().options.theme
    for (let index = 1; index <= 10; index += 1) {
      await updateSettings({ editorAutoSaveDelayMs: 1000 + index })
    }
    expect(connect).toHaveBeenCalledExactlyOnceWith('pty-1', { scrollbackRows: 24 })
    expect(harness.instances).toHaveLength(1)
    expect(terminal().options.theme).toBe(theme)
    expect(unsubscribe).not.toHaveBeenCalled()
  })

  it('updates cursor options on the existing terminal', async () => {
    render(<AgentTerminalPreview ptyId="pty-1" />)
    await act(async () => {})
    await updateSettings({
      terminalCursorStyle: 'bar',
      terminalCursorBlink: false
    })
    expect(connect).toHaveBeenCalledOnce()
    expect(terminal().options).toMatchObject({
      cursorStyle: 'bar',
      cursorBlink: false
    })
  })

  it.each([
    { terminalThemeDark: 'Builtin Tango Light' },
    { terminalColorOverrides: { background: '#123456' } },
    { terminalBackgroundOpacity: 0.5 },
    { terminalCursorOpacity: 0.5 },
    { terminalMinimumContrastRatio: 7 }
  ] satisfies Partial<GlobalSettings>[])(
    'replaces the terminal when theme or contrast changes: %o',
    async (updates) => {
      render(<AgentTerminalPreview ptyId="pty-1" />)
      await act(async () => {})
      await updateSettings(updates)
      expect(connect).toHaveBeenCalledTimes(2)
      expect(unsubscribe).toHaveBeenCalledExactlyOnceWith('pty-1')
      expect(terminal().dispose).toHaveBeenCalledOnce()
      expect(harness.instances).toHaveLength(2)
      if ('terminalMinimumContrastRatio' in updates) {
        expect(terminal(1).options.minimumContrastRatio).toBe(7)
      } else {
        expect(terminal(1).options.theme).not.toEqual(terminal().options.theme)
      }
    }
  )

  it('keeps a cloned imported theme but reconnects when its selected colors change', async () => {
    const custom = {
      id: 'manual:preview',
      name: 'Preview',
      source: 'manual' as const,
      mode: 'dark' as const,
      terminal: { background: '#123456', foreground: '#eeeeee', red: '#ff0000' },
      importedAt: '2026-09-25'
    }
    await updateSettings({
      terminalCustomThemes: [custom],
      terminalThemeDark: makeCustomTerminalThemeSelection(custom.id)
    })
    render(<AgentTerminalPreview ptyId="pty-1" />)
    await act(async () => {})
    expect(terminal().options.theme?.background).toBe('#123456')
    await updateSettings({ editorAutoSaveDelayMs: 1234 })
    expect(connect).toHaveBeenCalledOnce()
    await updateSettings({
      terminalCustomThemes: [{ ...custom, terminal: { ...custom.terminal, background: '#654321' } }]
    })
    expect(connect).toHaveBeenCalledTimes(2)
    expect(terminal(1).options.theme?.background).toBe('#654321')
  })

  it('reconnects when the effective OS theme changes', async () => {
    await updateSettings({ theme: 'system' })
    const view = render(<AgentTerminalPreview ptyId="pty-1" />)
    await act(async () => {})
    harness.systemPrefersDark = true
    view.rerender(<AgentTerminalPreview ptyId="pty-1" />)
    await act(async () => {})
    expect(connect).toHaveBeenCalledTimes(2)
    expect(terminal(1).options.theme).not.toEqual(terminal().options.theme)
  })

  it('uses current live options when an unrelated update arrives during connect', async () => {
    const gate = Promise.withResolvers<TerminalPreviewConnectResult>()
    connect.mockReturnValueOnce(gate.promise)
    render(<AgentTerminalPreview ptyId="pty-1" />)
    await updateSettings({ terminalCursorStyle: 'bar' })
    expect(connect).toHaveBeenCalledOnce()
    await act(async () => gate.resolve(connection))
    expect(harness.instances).toHaveLength(1)
    expect(terminal().options.cursorStyle).toBe('bar')
  })

  it('ignores an old pending connection after a relevant theme change', async () => {
    const gate = Promise.withResolvers<TerminalPreviewConnectResult>()
    connect.mockReturnValueOnce(gate.promise)
    render(<AgentTerminalPreview ptyId="pty-1" />)
    await updateSettings({ terminalMinimumContrastRatio: 7 })
    expect(connect).toHaveBeenCalledTimes(2)
    expect(harness.instances).toHaveLength(1)
    await act(async () => gate.resolve(connection))
    expect(harness.instances).toHaveLength(1)
    expect(terminal().options.minimumContrastRatio).toBe(7)
  })

  it('does not install a terminal after unmounting a pending connection', async () => {
    const gate = Promise.withResolvers<TerminalPreviewConnectResult>()
    connect.mockReturnValueOnce(gate.promise)
    const view = render(<AgentTerminalPreview ptyId="ssh:host@@pty-1" />)
    await updateSettings({ editorAutoSaveDelayMs: 1234 })
    view.unmount()
    await act(async () => gate.resolve(connection))
    expect(harness.instances).toHaveLength(0)
    expect(connect).toHaveBeenCalledOnce()
    expect(unsubscribe).toHaveBeenCalledExactlyOnceWith('ssh:host@@pty-1')
  })

  it('keeps a hidden mounted preview connected through unrelated settings updates', async () => {
    render(
      <div hidden>
        <AgentTerminalPreview ptyId="pty-1" />
      </div>
    )
    await act(async () => {})
    await updateSettings({ editorAutoSaveDelayMs: 1234 })
    expect(connect).toHaveBeenCalledOnce()
    expect(unsubscribe).not.toHaveBeenCalled()
  })

  it('still resyncs the same terminal after unrelated settings updates', async () => {
    render(<AgentTerminalPreview ptyId="pty-1" />)
    await act(async () => {})
    await updateSettings({ editorAutoSaveDelayMs: 1234 })
    await act(async () => emitData?.({ type: 'resync', ptyId: 'pty-1' }))
    expect(connect).toHaveBeenCalledTimes(2)
    expect(harness.instances).toHaveLength(1)
    expect(terminal().reset).toHaveBeenCalledOnce()
    expect(unsubscribe).not.toHaveBeenCalled()
  })
})
