// @vitest-environment happy-dom

import { act, useState, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentSkillSetupPanel } from './AgentSkillSetupPanel'
import { INLINE_SETUP_TERMINAL_STALL_TIMEOUT_MS } from '../onboarding/inline-setup-terminal-stall'
import { TooltipProvider } from '../ui/tooltip'

const INSTALL_COMMAND = 'npx skills add https://github.com/stablyai/orca --skill orca-cli --global'

const mocks = vi.hoisted(() => ({
  terminalProps: [] as {
    command: string
    onTerminalExit?: () => void
    onCommandFinished?: (bestEffortExitCode: number | null) => void
  }[]
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() }
}))

vi.mock('@/hooks/useInstalledAgentSkills', () => ({
  notifyInstalledAgentSkillsChanged: vi.fn(),
  notifyInstalledAgentSkillsRefreshed: vi.fn()
}))

vi.mock('@/hooks/useSkillFreshness', () => ({
  refreshSkillFreshness: vi.fn()
}))

vi.mock('../onboarding/OnboardingInlineCommandTerminal', () => ({
  OnboardingInlineCommandTerminal: (props: {
    command: string
    onTerminalExit?: () => void
    onCommandFinished?: (bestEffortExitCode: number | null) => void
  }) => {
    const [instance] = useState(() => mocks.terminalProps.push(props))
    return (
      <div data-testid="inline-command-terminal" data-instance={instance}>
        {props.command}
      </div>
    )
  }
}))

function panelProps(
  overrides: Partial<ComponentProps<typeof AgentSkillSetupPanel>> = {}
): ComponentProps<typeof AgentSkillSetupPanel> {
  return {
    title: 'CLI skill',
    description: 'Enables agents to use Orca workflows.',
    command: INSTALL_COMMAND,
    terminalTitle: 'CLI skill setup',
    terminalAriaLabel: 'CLI skill install terminal',
    terminalWorktreeId: 'settings-cli-skill-terminal',
    installed: false,
    loading: false,
    error: null,
    onRecheck: vi.fn(),
    ...overrides
  }
}

let root: Root | null = null
let container: HTMLDivElement | null = null

async function renderInteractivePanel(
  overrides: Partial<ComponentProps<typeof AgentSkillSetupPanel>> = {}
): Promise<HTMLDivElement> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <TooltipProvider>
        <AgentSkillSetupPanel {...panelProps(overrides)} />
      </TooltipProvider>
    )
  })
  await act(async () => {})
  return container
}

function findButton(label: string): HTMLButtonElement {
  const button = Array.from((container ?? document.body).querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === label
  )
  expect(button).toBeDefined()
  return button as HTMLButtonElement
}

async function clickButton(label: string): Promise<void> {
  await act(async () => {
    findButton(label).dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await act(async () => {})
}

describe('AgentSkillSetupPanel stdin stall', () => {
  beforeEach(() => {
    mocks.terminalProps.length = 0
    vi.useFakeTimers()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        cli: { getInstallStatus: vi.fn() },
        ui: { writeClipboardText: vi.fn() },
        platform: { get: () => ({ platform: 'linux' }) }
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

  it('does not launch the install command with -y', async () => {
    await renderInteractivePanel()
    await clickButton('Install')

    expect(mocks.terminalProps.at(-1)?.command).toBe(INSTALL_COMMAND)
    expect(mocks.terminalProps.at(-1)?.command).not.toContain('-y')
    expect(container?.textContent).toContain(INSTALL_COMMAND)
  })

  it('marks the row as in progress instead of silent Not installed', async () => {
    await renderInteractivePanel()
    await clickButton('Install')

    expect(container?.textContent).toContain('Installing...')
    expect(container?.textContent).not.toContain('Not installed')
    expect(container?.textContent).not.toMatch(/Waiting for input/)
  })

  it('surfaces a stdin stall instead of hanging on Not installed', async () => {
    await renderInteractivePanel()
    await clickButton('Install')

    await act(async () => {
      vi.advanceTimersByTime(INLINE_SETUP_TERMINAL_STALL_TIMEOUT_MS)
    })

    expect(container?.textContent).toContain('Waiting for input')
    expect(container?.textContent).not.toContain('Not installed')
    expect(container?.textContent).toContain(
      'The install is still running and may be waiting for input.'
    )
    expect(container?.textContent).toContain(
      'Answer the prompts in the terminal — they choose which agents to install into and whether to symlink or copy.'
    )
    expect(container?.textContent).toContain(
      'You can also copy the command and run it in your own terminal.'
    )
    expect(container?.querySelector('[data-testid="inline-command-terminal"]')).not.toBeNull()
    expect(findButton('Cancel').disabled).toBe(false)
  })

  it('flips the row to installed after a successful command', async () => {
    const onRecheck = vi.fn()
    await renderInteractivePanel({ onRecheck })
    await clickButton('Install')

    await act(async () => {
      mocks.terminalProps.at(-1)?.onCommandFinished?.(0)
    })
    await act(async () => {
      root?.render(
        <TooltipProvider>
          <AgentSkillSetupPanel {...panelProps({ installed: true, onRecheck })} />
        </TooltipProvider>
      )
    })

    expect(container?.textContent).toContain('Installed')
    expect(container?.textContent).not.toContain('Waiting for input')
    expect(onRecheck).toHaveBeenCalledOnce()
  })

  it('clears the stall when the user cancels the hung terminal', async () => {
    await renderInteractivePanel()
    await clickButton('Install')
    await act(async () => {
      vi.advanceTimersByTime(INLINE_SETUP_TERMINAL_STALL_TIMEOUT_MS)
    })

    await clickButton('Cancel')

    expect(container?.querySelector('[data-testid="inline-command-terminal"]')).toBeNull()
    expect(container?.textContent).not.toContain('Waiting for input')
    expect(container?.textContent).toContain('Not installed')
  })
})
