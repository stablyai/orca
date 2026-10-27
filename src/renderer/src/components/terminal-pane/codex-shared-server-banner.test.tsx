// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { FLOATING_TERMINAL_WORKTREE_ID, getDefaultSettings } from '../../../../shared/constants'
import { CodexSharedServerBanner } from './CodexSharedServerBanner'
import {
  CODEX_DISABLE_AUTO_START_COMMAND,
  CODEX_STOP_SHARED_SERVER_COMMAND,
  type CodexSharedServerStatus
} from '../../../../shared/codex-shared-server-command'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { Tab } from '../../../../shared/tab-types'

const routing = vi.hoisted(() => ({
  activateAndRevealWorkspace: vi.fn<(id: string) => unknown>(),
  revealFloatingWorkspacePanel: vi.fn(),
  createFloatingWorkspaceTerminalTab: vi.fn()
}))
vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorkspace: routing.activateAndRevealWorkspace
}))
vi.mock('@/lib/floating-workspace-panel-reveal', () => ({
  revealFloatingWorkspacePanel: routing.revealFloatingWorkspacePanel
}))
vi.mock('@/lib/floating-workspace-tab-creation', () => ({
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
const OLD_TAB_BODY =
  'This terminal was opened before Orca started giving each Codex its own server.'
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

  it('keeps the default Learn more on the Fix steps, with no old-terminal copy', async () => {
    setState({})
    await renderBanner()
    await advance(1_000)
    expect(paneElement.textContent).not.toContain(OLD_TAB_BODY)
    expect(() => button('Open new terminal')).toThrow()
    button('Fix')

    await act(async () => button('Learn more').click())
    expect(document.body.textContent).toContain('Give each Codex tab its own server')
    expect(document.body.textContent).not.toContain('Turn off sharing everywhere')
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
    isCodexOnSharedServer.mockResolvedValueOnce(NOT_JOINED)
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
    isCodexOnSharedServer.mockResolvedValue(NOT_JOINED)
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

  describe('in a terminal opened before the codex wrapper', () => {
    function terminalTab(worktreeId: string, groupId: string): Tab {
      return {
        id: 'unified-1',
        entityId: TAB_ID,
        groupId,
        worktreeId,
        contentType: 'terminal',
        label: 'Terminal',
        customLabel: null,
        color: null,
        sortOrder: 0,
        createdAt: 0
      }
    }

    it('says why this terminal shares the server and offers a new one instead of Fix', async () => {
      setState({})
      isCodexOnSharedServer.mockResolvedValue(OLD_TAB_JOINED)
      await renderBanner()
      await advance(1_000)

      expect(paneElement.textContent).toContain(TITLE)
      expect(paneElement.textContent).toContain(OLD_TAB_BODY)
      expect(paneElement.textContent).not.toContain('agent status may be wrong')
      expect(() => button('Fix')).toThrow()
      button('Open new terminal')
      button("Don't show again")
      button('Dismiss')
    })

    async function renderOldTab(worktreeId: string): Promise<() => Promise<void>> {
      const openNewTerminalTabInActiveWorkspace = vi.fn(() => Promise.resolve())
      setState({})
      useAppStore.setState({
        activeWorktreeId: 'wt-1',
        activeView: 'activity',
        unifiedTabsByWorktree: { [worktreeId]: [terminalTab(worktreeId, 'group-2')] },
        openNewTerminalTabInActiveWorkspace
      })
      isCodexOnSharedServer.mockResolvedValue(OLD_TAB_JOINED)
      await renderBanner()
      await advance(1_000)
      return openNewTerminalTabInActiveWorkspace
    }

    function dialog(): Element | null {
      return document.querySelector('[role="dialog"]')
    }

    it('explains the old terminal in Learn more, with no global fix', async () => {
      await renderOldTab('wt-1')
      expect(dialog()).toBeNull()
      await act(async () => button('Learn more').click())

      expect(dialog()?.textContent).toContain('Why this Codex shares a server')
      expect(dialog()?.textContent).toContain(
        'Open a new terminal to run Codex on a separate server.'
      )
      expect(dialog()?.textContent).not.toContain('Turn off sharing everywhere')
      expect(document.body.textContent).not.toContain(CODEX_DISABLE_AUTO_START_COMMAND)
      expect(document.body.textContent).not.toContain(CODEX_STOP_SHARED_SERVER_COMMAND)
    })

    it('opens a new terminal from Learn more and closes the dialog', async () => {
      const openNewTerminal = await renderOldTab('wt-1')
      await act(async () => button('Learn more').click())
      const inDialog = Array.from(dialog()?.querySelectorAll('button') ?? []).find(
        (candidate) => candidate.textContent?.trim() === 'Open new terminal'
      )
      await act(async () => inDialog?.click())

      expect(openNewTerminal).toHaveBeenCalledWith('group-2')
      expect(dialog()).toBeNull()
      expect(paneElement.textContent).toContain(OLD_TAB_BODY)
    })

    async function clickOpenNewTerminal(worktreeId: string): Promise<() => Promise<void>> {
      const openNewTerminalTabInActiveWorkspace = await renderOldTab(worktreeId)
      await act(async () => button('Open new terminal').click())
      expect(disableCodexSharedServerAutoStart).not.toHaveBeenCalled()
      expect(stopCodexSharedServer).not.toHaveBeenCalled()
      return openNewTerminalTabInActiveWorkspace
    }

    it.each([
      ['an active worktree viewed from Activity', 'wt-1'],
      ['another worktree', 'wt-other'],
      ['a folder workspace', 'folder:notes']
    ])('activates %s, then opens a terminal in its group', async (_label, worktreeId) => {
      const openNewTerminal = await clickOpenNewTerminal(worktreeId)
      expect(routing.activateAndRevealWorkspace).toHaveBeenCalledWith(worktreeId)
      expect(openNewTerminal).toHaveBeenCalledWith('group-2')
    })

    it('opens nothing when its workspace cannot be activated', async () => {
      routing.activateAndRevealWorkspace.mockReturnValue(false)
      const openNewTerminal = await clickOpenNewTerminal('folder:unmounted')
      expect(openNewTerminal).not.toHaveBeenCalled()
    })

    it('reveals the floating panel and opens a floating terminal', async () => {
      const openNewTerminal = await clickOpenNewTerminal(FLOATING_TERMINAL_WORKTREE_ID)
      expect(routing.revealFloatingWorkspacePanel).toHaveBeenCalledTimes(1)
      expect(routing.createFloatingWorkspaceTerminalTab).toHaveBeenCalledTimes(1)
      expect(routing.activateAndRevealWorkspace).not.toHaveBeenCalled()
      expect(openNewTerminal).not.toHaveBeenCalled()
    })
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
