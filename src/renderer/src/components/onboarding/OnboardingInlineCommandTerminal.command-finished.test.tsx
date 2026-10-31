// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OnboardingInlineCommandTerminal } from './OnboardingInlineCommandTerminal'
import { FeatureSetupInlineTerminal } from './FeatureSetupInlineTerminal'
import {
  ORCA_TERMINAL_COMMAND_FINISHED_EVENT,
  type TerminalCommandFinishedEventDetail
} from '@/hooks/terminal-command-finished-event'
import { PASTE_TERMINAL_TEXT_EVENT, type PasteTerminalTextDetail } from '@/constants/terminal'

const mocks = vi.hoisted(() => ({
  createTab: vi.fn(() => ({ id: 'tab-1', shellOverride: 'wsl.exe' })),
  closeTab: vi.fn(),
  setActiveTabForWorktree: vi.fn(),
  setTabCustomTitle: vi.fn(),
  track: vi.fn()
}))

vi.mock('@/lib/telemetry', () => ({ track: mocks.track }))
vi.mock('@/hooks/useActiveProjectSkillRuntime', () => ({
  useActiveProjectSkillRuntime: () => ({
    agentRuntime: { runtime: 'wsl', wslDistro: 'Ubuntu', label: 'WSL Ubuntu' },
    installDisabledReason: null,
    terminalShellOverride: 'powershell.exe'
  })
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
    mocks.track.mockClear()
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
    vi.restoreAllMocks()
  })

  it.each(['Mac', 'Windows'])(
    'restores WSL feature terminal telemetry and ignores the %s continue shortcut',
    async (platform) => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(platform)
      container = document.createElement('div')
      document.body.appendChild(container)
      root = createRoot(container)
      const selection = {
        browserUse: true,
        computerUse: false,
        linearTickets: true,
        orchestration: true
      }
      await act(async () => {
        root?.render(
          <FeatureSetupInlineTerminal command="npx skills add orca-cli" selection={selection} />
        )
      })
      const telemetry = {
        browser_use: true,
        computer_use: false,
        linear_tickets: true,
        orchestration: true,
        selected_count: 2
      }
      expect(mocks.track).toHaveBeenCalledExactlyOnceWith(
        'onboarding_feature_setup_terminal_opened',
        telemetry
      )
      const terminal = container.querySelector('[data-testid="terminal-pane"]')
      expect(terminal).not.toBeNull()
      await act(async () => {
        terminal?.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Enter',
            metaKey: platform === 'Mac',
            ctrlKey: platform !== 'Mac',
            bubbles: true
          })
        )
      })
      expect(mocks.track).toHaveBeenCalledTimes(1)
      await act(async () => {
        terminal?.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }))
        terminal?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
      })
      expect(mocks.track).toHaveBeenCalledTimes(2)
      expect(mocks.track).toHaveBeenLastCalledWith('onboarding_feature_setup_terminal_interacted', {
        ...telemetry,
        method: 'keyboard'
      })
    }
  )

  it('tracks a direct pointer interaction in the WSL feature terminal once', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(
        <FeatureSetupInlineTerminal
          command="npx skills add orca-cli"
          selection={{
            browserUse: true,
            computerUse: false,
            linearTickets: false,
            orchestration: false
          }}
        />
      )
    })
    await act(async () => {
      const terminal = container?.querySelector('[data-testid="terminal-pane"]')
      terminal?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
      terminal?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    })
    expect(mocks.track).toHaveBeenCalledTimes(2)
    expect(mocks.track).toHaveBeenLastCalledWith(
      'onboarding_feature_setup_terminal_interacted',
      expect.objectContaining({ method: 'pointer', selected_count: 1 })
    )
  })

  it('auto-pastes the command into the tab it created', async () => {
    vi.useFakeTimers()
    mocks.createTab.mockReturnValueOnce({ id: 'tab-1', shellOverride: 'zsh' })
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
            title="Skill setup"
            ariaLabel="Skill setup terminal"
          />
        )
      })
      await act(async () => {})
      await act(async () => {
        vi.advanceTimersByTime(250)
      })

      expect(mocks.createTab).toHaveBeenCalledWith(
        'ephemeral-setup-terminal:onboarding-inline-terminal',
        undefined,
        undefined,
        expect.objectContaining({ activate: false })
      )
      expect(pasted).toContainEqual({ tabId: 'tab-1', text: 'npx skills add orchestration' })
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

    // Production events use the branded PTY ID; matching the raw panel ID would never receive them.
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
