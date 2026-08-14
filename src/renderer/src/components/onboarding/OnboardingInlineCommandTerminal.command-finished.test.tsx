// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OnboardingInlineCommandTerminal } from './OnboardingInlineCommandTerminal'
import {
  ORCA_TERMINAL_COMMAND_FINISHED_EVENT,
  type TerminalCommandFinishedEventDetail
} from '@/hooks/terminal-command-finished-event'
import { PASTE_TERMINAL_TEXT_EVENT, type PasteTerminalTextDetail } from '@/constants/terminal'

const mocks = vi.hoisted(() => ({
  createTab: vi.fn(() => ({ id: 'tab-1', shellOverride: 'wsl.exe' })),
  closeTab: vi.fn(),
  setActiveTabForWorktree: vi.fn(),
  setTabCustomTitle: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      createTab: mocks.createTab,
      closeTab: mocks.closeTab,
      setActiveTabForWorktree: mocks.setActiveTabForWorktree,
      setTabCustomTitle: mocks.setTabCustomTitle
    })
}))

vi.mock('@/components/terminal-pane/TerminalPane', () => ({
  default: (props: { tabId: string }) => (
    <div data-testid="terminal-pane" data-terminal-tab-id={props.tabId}>
      <div data-pty-id="pty-1" />
      <div className="xterm-rows">$</div>
    </div>
  )
}))

vi.mock('@/lib/focus-terminal-tab-surface', () => ({
  focusTerminalTabSurface: vi.fn()
}))

function dispatchCommandFinished(worktreeId: string, exitCode: number | null): void {
  window.dispatchEvent(
    new CustomEvent<TerminalCommandFinishedEventDetail>(ORCA_TERMINAL_COMMAND_FINISHED_EVENT, {
      detail: { worktreeId, exitCode }
    })
  )
}

let root: Root | null = null
let container: HTMLDivElement | null = null

describe('OnboardingInlineCommandTerminal command-finished forwarding', () => {
  beforeEach(() => {
    mocks.createTab.mockClear()
    mocks.closeTab.mockClear()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        app: {
          getFloatingTerminalCwd: vi.fn(async () => '/tmp')
        }
      }
    })
  })

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount()
      })
    }
    root = null
    container?.remove()
    container = null
    Reflect.deleteProperty(window, 'api')
    vi.useRealTimers()
  })

  it('prepares auto-paste again when the resolved tab shell changes', async () => {
    vi.useFakeTimers()
    mocks.createTab
      .mockReturnValueOnce({ id: 'tab-1', shellOverride: 'wsl.exe' })
      .mockReturnValueOnce({ id: 'tab-2', shellOverride: 'powershell.exe' })
    const prepareCommandForShell = vi.fn(
      (command: string, shellOverride: string | undefined) => `${shellOverride}:${command}`
    )
    const pasted: PasteTerminalTextDetail[] = []
    const handlePaste = (event: Event): void => {
      pasted.push((event as CustomEvent<PasteTerminalTextDetail>).detail)
    }
    window.addEventListener(PASTE_TERMINAL_TEXT_EVENT, handlePaste)
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    try {
      await act(async () => {
        root?.render(
          <OnboardingInlineCommandTerminal
            command="npx skills add orchestration"
            prepareCommandForShell={prepareCommandForShell}
            shellOverride="powershell.exe"
            title="Skill setup"
            ariaLabel="Skill setup terminal"
          />
        )
      })
      await act(async () => {})
      await act(async () => {
        vi.advanceTimersByTime(250)
      })
      await act(async () => {
        root?.render(
          <OnboardingInlineCommandTerminal
            command="npx skills add orchestration"
            forceHostRuntime
            prepareCommandForShell={prepareCommandForShell}
            shellOverride="powershell.exe"
            title="Skill setup"
            ariaLabel="Skill setup terminal"
          />
        )
      })
      await act(async () => {})
      await act(async () => {
        vi.advanceTimersByTime(250)
      })

      expect(prepareCommandForShell).toHaveBeenCalledWith('npx skills add orchestration', 'wsl.exe')
      expect(prepareCommandForShell).toHaveBeenCalledWith(
        'npx skills add orchestration',
        'powershell.exe'
      )
      expect(mocks.createTab).toHaveBeenCalledWith(
        'ephemeral-setup-terminal:onboarding-inline-terminal',
        undefined,
        'powershell.exe',
        expect.objectContaining({ forceHostRuntime: true })
      )
      expect(pasted).toContainEqual({
        tabId: 'tab-1',
        text: 'wsl.exe:npx skills add orchestration'
      })
      expect(pasted).toContainEqual({
        tabId: 'tab-2',
        text: 'powershell.exe:npx skills add orchestration'
      })
    } finally {
      window.removeEventListener(PASTE_TERMINAL_TEXT_EVENT, handlePaste)
    }
  })

  it('forwards exit codes only for its own branded worktree id', async () => {
    const onCommandFinished = vi.fn()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(
        <OnboardingInlineCommandTerminal
          command="npx skills add --skill orchestration --global"
          title="Skill setup"
          ariaLabel="Skill setup terminal"
          worktreeId="settings-orchestration-skill-terminal"
          onCommandFinished={onCommandFinished}
        />
      )
    })
    await act(async () => {})

    await act(async () => {
      dispatchCommandFinished('some-other-worktree', 1)
    })
    expect(onCommandFinished).not.toHaveBeenCalled()

    // Why unbranded-miss matters: pty-connection dispatches the BRANDED id;
    // matching the raw panel id would silently never fire in production.
    await act(async () => {
      dispatchCommandFinished('settings-orchestration-skill-terminal', 1)
    })
    expect(onCommandFinished).not.toHaveBeenCalled()

    await act(async () => {
      dispatchCommandFinished('ephemeral-setup-terminal:settings-orchestration-skill-terminal', 1)
    })
    expect(onCommandFinished).toHaveBeenCalledWith(1)

    await act(async () => {
      dispatchCommandFinished(
        'ephemeral-setup-terminal:settings-orchestration-skill-terminal',
        null
      )
    })
    expect(onCommandFinished).toHaveBeenLastCalledWith(null)
  })
})
