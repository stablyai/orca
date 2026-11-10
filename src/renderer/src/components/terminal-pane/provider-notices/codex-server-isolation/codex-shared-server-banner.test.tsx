// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import type { GlobalSettings } from '../../../../../../shared/global-settings-types'
import { getDefaultSettings } from '../../../../../../shared/constants'
import { CodexSharedServerBanner } from './CodexSharedServerBanner'
import type { CodexSharedServerStatus } from '../../../../../../shared/codex-shared-server-command'
import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'

const routing = vi.hoisted(() => ({
  activateAndRevealWorkspace: vi.fn<(id: string) => unknown>(),
  revealFloatingWorkspacePanel: vi.fn(),
  createFloatingWorkspaceTerminalTab: vi.fn()
}))
vi.mock('@/lib/workspace/activation/worktree-activation', () => ({
  activateAndRevealWorkspace: routing.activateAndRevealWorkspace
}))
vi.mock('@/components/floating-terminal/floating-workspace-panel-reveal', () => ({
  revealFloatingWorkspacePanel: routing.revealFloatingWorkspacePanel
}))
vi.mock('@/components/floating-terminal/floating-workspace-tab-creation', () => ({
  createFloatingWorkspaceTerminalTab: routing.createFloatingWorkspaceTerminalTab
}))

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const TAB_ID = 'tab-1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = makePaneKey(TAB_ID, LEAF_ID)
const JOINED: CodexSharedServerStatus = { joined: true, openedBeforeWrapper: false }
const NOT_JOINED: CodexSharedServerStatus = { joined: false }
const OLD_TAB_JOINED: CodexSharedServerStatus = { joined: true, openedBeforeWrapper: true }
const TITLE = 'This Codex is sharing a server'
let paneElement: HTMLDivElement
let root: Root
let isCodexOnSharedServer: ReturnType<
  typeof vi.fn<(id: string) => Promise<CodexSharedServerStatus>>
>
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
    root.render(<CodexSharedServerBanner ptyId={ptyId} tabId={TAB_ID} leafId={LEAF_ID} />)
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
  vi.clearAllMocks()
  routing.activateAndRevealWorkspace.mockReturnValue({ primaryTabId: null })
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  useAppStore.setState(useAppStore.getInitialState(), true)
  ptyId = `pty-${(nextPtyId += 1)}`
  paneElement = document.createElement('div')
  paneElement.className = 'pane'
  document.body.appendChild(paneElement)
  root = createRoot(paneElement)
  isCodexOnSharedServer = vi.fn(() => Promise.resolve<CodexSharedServerStatus>(JOINED))
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
  it('keeps asking while Codex starts, then stops once it has an answer', async () => {
    setState({})
    isCodexOnSharedServer.mockResolvedValueOnce(NOT_JOINED)
    await renderBanner()
    await advance(1_000)
    expect(paneElement.textContent).toBe('')
    await advance(4_000)
    expect(paneElement.textContent).toContain(TITLE)
    await advance(60_000)
    expect(isCodexOnSharedServer).toHaveBeenCalledTimes(2)
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
    isCodexOnSharedServer.mockResolvedValue(NOT_JOINED)
    await act(async () => confirm.at(-1)?.click())
    expect(stopCodexSharedServer).toHaveBeenCalledWith(ptyId)
    expect(document.body.textContent).toContain('Stopped')

    await act(async () => button('Done').click())
    await advance(20_000)
    expect(paneElement.textContent).toBe('')
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

  describe('returning focus when a dialog closes', () => {
    // Why a real xterm textarea: the dialogs have no trigger, so only the hook can restore focus.
    function mountActiveTerminal(): HTMLTextAreaElement {
      useAppStore.setState({
        activeWorktreeId: 'wt-1',
        activeTabType: 'terminal',
        activeTabIdByWorktree: { 'wt-1': TAB_ID },
        terminalLayoutsByTabId: {
          [TAB_ID]: { root: null, activeLeafId: LEAF_ID, expandedLeafId: null }
        }
      })
      const tab = document.createElement('div')
      tab.dataset.terminalTabId = TAB_ID
      const leaf = document.createElement('div')
      leaf.dataset.leafId = LEAF_ID
      const xterm = document.createElement('textarea')
      xterm.className = 'xterm-helper-textarea'
      leaf.append(xterm)
      tab.append(leaf)
      document.body.append(tab)
      xterm.focus()
      return xterm
    }

    async function pressEscape(): Promise<void> {
      await act(async () => {
        ;(document.activeElement ?? document.body).dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
        )
      })
      await advance(100)
    }

    afterEach(() => {
      document.querySelector('[data-terminal-tab-id]')?.remove()
    })

    it.each([
      ['Fix', JOINED, 'Fix'],
      ['old-terminal Learn more', OLD_TAB_JOINED, 'Learn more']
    ])(
      'returns focus to the terminal after Esc closes the %s dialog',
      async (_l, status, label) => {
        setState({})
        isCodexOnSharedServer.mockResolvedValue(status)
        const xterm = mountActiveTerminal()
        await renderBanner()
        await advance(1_000)
        await act(async () => button(label).click())
        expect(document.querySelector('[role="dialog"]')).not.toBeNull()
        expect(document.activeElement).not.toBe(xterm)

        await pressEscape()

        expect(document.querySelector('[role="dialog"]')).toBeNull()
        expect(document.activeElement).toBe(xterm)
      }
    )

    it('leaves focus in the new terminal after Open new terminal', async () => {
      setState({})
      const xterm = mountActiveTerminal()
      const newTerminal = document.createElement('textarea')
      document.body.append(newTerminal)
      useAppStore.setState({
        unifiedTabsByWorktree: {
          'wt-1': [
            {
              id: 'unified-1',
              entityId: TAB_ID,
              groupId: 'group-1',
              worktreeId: 'wt-1',
              contentType: 'terminal',
              label: 'Terminal',
              customLabel: null,
              color: null,
              sortOrder: 0,
              createdAt: 0
            }
          ]
        },
        openNewTerminalTabInActiveWorkspace: vi.fn(() => {
          newTerminal.focus()
          return Promise.resolve()
        })
      })
      isCodexOnSharedServer.mockResolvedValue(OLD_TAB_JOINED)
      await renderBanner()
      await advance(1_000)
      await act(async () => button('Learn more').click())
      await clickDialogOpenNewTerminal()

      expect(document.querySelector('[role="dialog"]')).toBeNull()
      expect(document.activeElement).toBe(newTerminal)
      expect(document.activeElement).not.toBe(xterm)
      newTerminal.remove()
    })

    async function clickDialogOpenNewTerminal(): Promise<void> {
      const inDialog = Array.from(
        document.querySelector('[role="dialog"]')?.querySelectorAll('button') ?? []
      ).find((candidate) => candidate.textContent?.trim() === 'Open new terminal')
      await act(async () => inDialog?.click())
      await advance(100)
    }

    it('returns focus to this terminal when Open new terminal cannot open one', async () => {
      setState({})
      useAppStore.setState({ unifiedTabsByWorktree: {} })
      const xterm = mountActiveTerminal()
      isCodexOnSharedServer.mockResolvedValue(OLD_TAB_JOINED)
      await renderBanner()
      await advance(1_000)
      await act(async () => button('Learn more').click())

      await clickDialogOpenNewTerminal()

      expect(document.querySelector('[role="dialog"]')).toBeNull()
      expect(document.activeElement).toBe(xterm)
    })

    it('keeps the Learn more dialog open when this Codex ends, then returns focus', async () => {
      setState({})
      const xterm = mountActiveTerminal()
      isCodexOnSharedServer.mockResolvedValue(OLD_TAB_JOINED)
      await renderBanner()
      await advance(1_000)
      await act(async () => button('Learn more').click())

      setState({}, null)
      await advance(100)
      expect(document.querySelector('[role="dialog"]')).not.toBeNull()
      expect(paneElement.textContent).toBe('')

      await pressEscape()

      expect(document.querySelector('[role="dialog"]')).toBeNull()
      expect(document.activeElement).toBe(xterm)
    })

    it('returns focus to the pane terminal after Stop server ends its Codex', async () => {
      setState({})
      const xterm = mountActiveTerminal()
      await renderBanner()
      await advance(1_000)
      await act(async () => button('Fix').click())
      await act(async () => button('Turn off').click())
      await act(async () => button('Stop server').click())
      isCodexOnSharedServer.mockResolvedValue(NOT_JOINED)
      const confirm = Array.from(document.querySelectorAll('button')).filter(
        (candidate) => candidate.textContent?.trim() === 'Stop server'
      )
      await act(async () => confirm.at(-1)?.click())
      await advance(20_000)
      expect(stopCodexSharedServer).toHaveBeenCalledWith(ptyId)
      expect(document.body.textContent).toContain('Stopped')

      await pressEscape()

      expect(document.querySelector('[role="dialog"]')).toBeNull()
      expect(paneElement.textContent).toBe('')
      expect(document.activeElement).toBe(xterm)
    })
  })
})
