// @vitest-environment happy-dom

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ITerminalOptions } from '@xterm/xterm'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { TerminalPreviewConnectResult } from '../../../../shared/terminal/replay/terminal-preview'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'

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
  createPreviewBoxFit: () => ({ schedule: vi.fn(), dispose: vi.fn() })
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
const onData = vi.fn(() => offData)
const connection: TerminalPreviewConnectResult = {
  snapshot: { data: 'agent prompt', cols: 80, rows: 24, seq: 1 },
  replay: []
}
let settings: GlobalSettings
let originalApi: PropertyDescriptor | undefined

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
})
