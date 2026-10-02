// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { getDefaultSettings } from '../../../../shared/constants'
import { CodexSharedServerBanner } from './CodexSharedServerBanner'
import {
  CODEX_DISABLE_AUTO_START_COMMAND,
  CODEX_STOP_SHARED_SERVER_COMMAND
} from '../../../../shared/codex-shared-server-command'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const PANE_KEY = 'tab-1:leaf-1'
const TITLE = 'This Codex is sharing a server'
let paneElement: HTMLDivElement
let root: Root
let isCodexOnSharedServer: ReturnType<typeof vi.fn<(id: string) => Promise<boolean>>>
let disableCodexSharedServerAutoStart: ReturnType<typeof vi.fn<(id: string) => Promise<boolean>>>
let stopCodexSharedServer: ReturnType<typeof vi.fn<(id: string) => Promise<boolean>>>
let writeClipboardText: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>
let updateSettings: ReturnType<typeof vi.fn<(updates: Partial<GlobalSettings>) => Promise<void>>>
let nextPtyId = 0
let ptyId: string

class ResizeObserverStub {
  observe(): void {}
  disconnect(): void {}
}

function setState(settings: Partial<GlobalSettings>, agent: 'codex' | null = 'codex'): void {
  useAppStore.setState({
    settings: { ...getDefaultSettings('/home/me'), ...settings },
    paneForegroundAgentByPaneKey: agent ? { [PANE_KEY]: { agent, shellForeground: false } } : {},
    updateSettings
  })
}

async function renderBanner(): Promise<void> {
  await act(async () => {
    root.render(<CodexSharedServerBanner ptyId={ptyId} paneKey={PANE_KEY} />)
  })
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

// Why document: the dialog portals out of the pane.
function button(label: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll('button')).find(
    (candidate) =>
      candidate.textContent?.trim() === label || candidate.getAttribute('aria-label') === label
  )
  if (!match) {
    throw new Error(`missing ${label} button`)
  }
  return match
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  useAppStore.setState(useAppStore.getInitialState(), true)
  ptyId = `pty-${(nextPtyId += 1)}`
  paneElement = document.createElement('div')
  paneElement.className = 'pane'
  document.body.appendChild(paneElement)
  root = createRoot(paneElement)
  isCodexOnSharedServer = vi.fn(() => Promise.resolve(true))
  disableCodexSharedServerAutoStart = vi.fn(() => Promise.resolve(true))
  stopCodexSharedServer = vi.fn(() => Promise.resolve(true))
  writeClipboardText = vi.fn(() => Promise.resolve())
  updateSettings = vi.fn((updates: Partial<GlobalSettings>) => {
    setState({ ...useAppStore.getState().settings, ...updates })
    return Promise.resolve()
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      pty: { isCodexOnSharedServer, disableCodexSharedServerAutoStart, stopCodexSharedServer },
      ui: { writeClipboardText, set: vi.fn(() => Promise.resolve()) }
    }
  })
})

afterEach(() => {
  act(() => root.unmount())
  paneElement.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

describe('CodexSharedServerBanner', () => {
  it('shows the warning and reserves its height at the top of the pane', async () => {
    setState({})
    await renderBanner()
    expect(paneElement.textContent).not.toContain(TITLE)

    await advance(1_000)

    expect(isCodexOnSharedServer).toHaveBeenCalledWith(ptyId)
    expect(paneElement.textContent).toContain('agent status may be wrong')
    expect(paneElement.querySelector(':scope > .pane-top-banner')).not.toBeNull()
    expect(paneElement.style.getPropertyValue('--orca-pane-top-banner-height')).toMatch(/px$/)
  })

  it("retires the one-time 'runs Codex without its shared server' toast, which it contradicts", async () => {
    setState({})
    useAppStore.setState({ codexTerminalServerIsolationNoticeSeen: false })
    const dismiss = vi.spyOn(toast, 'dismiss')
    await renderBanner()
    await advance(1_000)

    expect(paneElement.textContent).toContain(TITLE)
    expect(dismiss).toHaveBeenCalledWith('codex-terminal-server-isolation-notice')
    expect(useAppStore.getState().codexTerminalServerIsolationNoticeSeen).toBe(true)
  })

  it('keeps asking while Codex starts, then stops once it has an answer', async () => {
    setState({})
    isCodexOnSharedServer.mockResolvedValueOnce(false)
    await renderBanner()
    await advance(1_000)
    expect(paneElement.textContent).toBe('')
    await advance(4_000)
    expect(paneElement.textContent).toContain(TITLE)
    await advance(60_000)
    expect(isCodexOnSharedServer).toHaveBeenCalledTimes(2)
  })

  it('shows each command Orca runs, then turns sharing off and reads back success', async () => {
    setState({})
    await renderBanner()
    await advance(1_000)
    await act(async () => button('Fix').click())
    expect(document.body.textContent).toContain(CODEX_DISABLE_AUTO_START_COMMAND)
    expect(document.body.textContent).toContain(CODEX_STOP_SHARED_SERVER_COMMAND)

    await act(async () => button('Turn off').click())

    expect(disableCodexSharedServerAutoStart).toHaveBeenCalledWith(ptyId)
    expect(document.body.textContent).toContain('Turned off')
    expect(() => button('Copy')).toThrow()
  })

  it('falls back to a copyable command when a step fails', async () => {
    disableCodexSharedServerAutoStart.mockResolvedValueOnce(false)
    setState({})
    await renderBanner()
    await advance(1_000)
    await act(async () => button('Fix').click())
    await act(async () => button('Turn off').click())

    expect(document.body.textContent).toContain("Orca couldn't turn this off.")
    expect(document.body.textContent).not.toContain('Turned off')
    await act(async () => button('Copy').click())
    expect(writeClipboardText).toHaveBeenCalledWith(CODEX_DISABLE_AUTO_START_COMMAND)
  })

  it('confirms before stopping the server, then hides once it is gone', async () => {
    setState({})
    await renderBanner()
    await advance(1_000)
    await act(async () => button('Fix').click())
    await act(async () => button('Turn off').click())
    await act(async () => button('Stop server').click())
    expect(stopCodexSharedServer).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Stop the shared server?')

    await act(async () => button('Cancel').click())
    expect(stopCodexSharedServer).not.toHaveBeenCalled()

    await act(async () => button('Stop server').click())
    const confirm = Array.from(document.querySelectorAll('button')).filter(
      (candidate) => candidate.textContent?.trim() === 'Stop server'
    )
    isCodexOnSharedServer.mockResolvedValue(false)
    await act(async () => confirm.at(-1)?.click())
    expect(stopCodexSharedServer).toHaveBeenCalledWith(ptyId)
    expect(document.body.textContent).toContain('Stopped')

    await act(async () => button('Done').click())
    await advance(20_000)
    expect(paneElement.textContent).toBe('')
  })

  it.each([
    ['before sharing is turned off', false],
    ['when turning sharing off failed', true]
  ])('keeps Stop server unavailable %s', async (_label, turnOffFails) => {
    disableCodexSharedServerAutoStart.mockResolvedValueOnce(false)
    setState({})
    await renderBanner()
    await advance(1_000)
    await act(async () => button('Fix').click())
    if (turnOffFails) {
      await act(async () => button('Turn off').click())
    }
    expect(button('Stop server').disabled).toBe(true)
  })

  it('dismisses for this pane only, and stays dismissed after a remount', async () => {
    setState({})
    await renderBanner()
    await advance(1_000)
    await act(async () => button('Dismiss').click())
    expect(paneElement.textContent).toBe('')
    expect(paneElement.style.getPropertyValue('--orca-pane-top-banner-height')).toBe('')
    expect(updateSettings).not.toHaveBeenCalled()

    act(() => root.unmount())
    root = createRoot(paneElement)
    await renderBanner()
    await advance(20_000)
    expect(paneElement.textContent).toBe('')
  })

  it("persists Don't show again as a setting", async () => {
    setState({})
    await renderBanner()
    await advance(1_000)
    await act(async () => button("Don't show again").click())
    expect(updateSettings).toHaveBeenCalledWith({ codexSharedServerWarning: false })
    expect(paneElement.textContent).toBe('')
  })

  it.each([
    ['isolation is off', { codexTerminalServerIsolation: false }],
    ["Don't show again was chosen", { codexSharedServerWarning: false }]
  ])('never asks or shows when %s', async (_label, settings) => {
    setState(settings)
    await renderBanner()
    await advance(20_000)
    expect(isCodexOnSharedServer).not.toHaveBeenCalled()
    expect(paneElement.textContent).toBe('')
  })

  it('hides when Codex leaves the pane', async () => {
    setState({})
    await renderBanner()
    await advance(1_000)
    expect(paneElement.textContent).toContain(TITLE)
    await act(async () => setState({}, null))
    expect(paneElement.textContent).toBe('')
  })
})
