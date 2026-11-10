// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OnboardingInlineCommandTerminal } from './OnboardingInlineCommandTerminal'

import {
  ORCA_TERMINAL_COMMAND_FINISHED_EVENT,
  type TerminalCommandFinishedEventDetail
} from '@/hooks/terminal-command-finished-event'

const mocks = vi.hoisted(() => ({
  createTab: vi.fn(() => ({ id: 'tab-1', shellOverride: 'wsl.exe' })),
  closeTab: vi.fn(),
  setActiveTabForWorktree: vi.fn(),
  setTabCustomTitle: vi.fn(),
  track: vi.fn()
}))

vi.mock('@/lib/telemetry', () => ({ track: mocks.track }))
vi.mock('@/hooks/skills/runtime/useActiveProjectSkillRuntime', () => ({
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

vi.mock('@/components/terminal-pane/input/focus/focus-terminal-tab-surface', () => ({
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
