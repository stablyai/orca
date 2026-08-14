// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { getBuiltinTheme, resolveEffectiveTerminalAppearance } from '@/lib/terminal-theme'
import { composeActiveTerminalTheme } from '../../../../shared/compose-active-terminal-theme'

const terminalHarness = vi.hoisted(() => ({
  instances: [] as { options: { theme?: { background?: string } }; dispose: () => void }[]
}))

const storeState = vi.hoisted(() => ({
  settings: null as ReturnType<typeof getDefaultSettings> | null
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: { theme?: { background?: string } }
    buffer = { active: { cursorY: 0 } }
    modes = { bracketedPasteMode: false }
    element = document.createElement('div')
    unicode = { activeVersion: '6', versions: ['6', '11'], register: vi.fn() }
    write = vi.fn()
    open = vi.fn()
    focus = vi.fn()
    dispose = vi.fn()
    resize = vi.fn()
    reset = vi.fn()
    loadAddon = vi.fn()
    attachCustomWheelEventHandler = vi.fn()
    attachCustomKeyEventHandler = vi.fn()
    onData = vi.fn(() => ({ dispose: vi.fn() }))
    constructor(options: { theme?: { background?: string } } = {}) {
      this.options = { ...options }
      terminalHarness.instances.push(this)
    }
  }
}))

vi.mock(import('@/lib/pane-manager/pane-terminal-options'), async (importOriginal) => ({
  ...(await importOriginal()),
  buildDefaultTerminalOptions: () => ({})
}))

vi.mock('@/components/terminal-pane/use-system-prefers-dark', () => ({
  useSystemPrefersDark: () => true
}))

vi.mock('@/store', () => {
  const useAppStore = (selector: (s: typeof storeState) => unknown): unknown => selector(storeState)
  useAppStore.getState = (): typeof storeState => storeState
  return { useAppStore }
})

import { AgentTerminalPreview } from './AgentTerminalPreview'

function expectedTheme(agent: 'codex' | null): { background?: string } | null {
  const settings = storeState.settings
  if (!settings) {
    return null
  }
  const appearance = resolveEffectiveTerminalAppearance(settings, true, agent)
  return composeActiveTerminalTheme(
    appearance.theme ?? getBuiltinTheme(appearance.themeName),
    settings
  )
}

describe('AgentTerminalPreview theme', () => {
  beforeEach(() => {
    terminalHarness.instances.length = 0
    storeState.settings = {
      ...getDefaultSettings('/tmp'),
      agentTerminalThemes: { codex: { dark: 'Tokyo Night' } }
    }
    Object.assign(window, {
      api: {
        terminalPreview: {
          connect: vi.fn().mockResolvedValue({
            snapshot: { data: '', cols: 80, rows: 24, seq: 1 },
            replay: []
          }),
          input: vi.fn(),
          fit: vi.fn(),
          ack: vi.fn(),
          unsubscribe: vi.fn(),
          onData: () => vi.fn()
        },
        ui: {
          readClipboardText: vi.fn(),
          writeClipboardText: vi.fn(),
          writeTerminalClipboardText: vi.fn(),
          onAppMenuPaste: () => vi.fn(),
          onAppMenuSelectionAction: () => vi.fn(),
          performNativeSelectionAction: vi.fn()
        }
      }
    })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('composes the Codex override when agentType is codex', async () => {
    render(<AgentTerminalPreview ptyId="pty-1" agentType="codex" />)
    await waitFor(() => expect(terminalHarness.instances).toHaveLength(1))
    expect(terminalHarness.instances[0]!.options.theme?.background).toBe(
      expectedTheme('codex')?.background
    )
    expect(expectedTheme('codex')?.background).not.toBe(expectedTheme(null)?.background)
  })

  it('falls back to the global theme for an unknown agentType', async () => {
    render(<AgentTerminalPreview ptyId="pty-1" agentType="not-a-tui-agent" />)
    await waitFor(() => expect(terminalHarness.instances).toHaveLength(1))
    expect(terminalHarness.instances[0]!.options.theme?.background).toBe(
      expectedTheme(null)?.background
    )
  })

  it('does not remount when a value-equal theme re-render lands', async () => {
    const view = render(<AgentTerminalPreview ptyId="pty-1" agentType="codex" />)
    await waitFor(() => expect(terminalHarness.instances).toHaveLength(1))
    const first = terminalHarness.instances[0]!
    storeState.settings = { ...storeState.settings! }
    view.rerender(<AgentTerminalPreview ptyId="pty-1" agentType="codex" />)
    await waitFor(() => expect(first.options.theme?.background).toBe(expectedTheme('codex')?.background))
    expect(terminalHarness.instances).toHaveLength(1)
  })
})
