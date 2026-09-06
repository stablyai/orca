import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'
import { focusActiveTerminalInput, waitForTerminalOutput } from './terminal'
import type { BuiltInWindowsTerminalShell } from '../../../src/shared/windows-terminal-shell'
import { quoteStartupArg } from '../../../src/shared/tui-agent-startup-shell'

export const GOLDEN_STUB_READY_MARKER = 'GOLDEN_STUB_AGENT_READY'
export const GOLDEN_STUB_EXIT_MARKER = 'GOLDEN_STUB_AGENT_EXITED'

/** Agents exposed by the fixture directory for tab-bar detection. */
export const GOLDEN_STUB_AGENTS = [
  { id: 'codex', menuItemName: /^Codex(?:\s|$)/i },
  { id: 'claude', menuItemName: /^Claude(?:\s|$)/i },
  { id: 'trae', menuItemName: /^Trae(?:\s|$)/i }
] as const

const fixtureDir = path.join(process.cwd(), 'tests', 'e2e', 'fixtures', 'golden-stub-agent')

function getGoldenStubAgentCommand(agent: (typeof GOLDEN_STUB_AGENTS)[number]['id']): string {
  const executable = agent === 'trae' ? 'traecli' : agent
  // Why absolute on POSIX: Orca's bash wrapper sources /etc/profile, and some
  // distributions replace PATH there before the startup command is delivered.
  // Windows shells keep the fixture PATH and need different absolute-path
  // invocation syntax, so use the bare shim name there.
  return process.platform === 'win32'
    ? executable
    : quoteStartupArg(path.join(fixtureDir, executable), 'posix')
}

export function getGoldenStubAgentLaunchEnv(): NodeJS.ProcessEnv {
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH'
  return {
    [pathKey]: [fixtureDir, process.env[pathKey] ?? ''].filter(Boolean).join(path.delimiter)
  }
}

export async function configureGoldenStubAgent(
  page: Page,
  options: {
    agent?: (typeof GOLDEN_STUB_AGENTS)[number]['id'] | 'grok'
    agentArgs?: string
    /** Windows default shell the launch command must survive; ignored elsewhere. */
    windowsShell?: BuiltInWindowsTerminalShell
  } = {}
): Promise<void> {
  const agent = options.agent ?? 'codex'
  const agentCommand = getGoldenStubAgentCommand(agent)
  await page.evaluate(
    async ({ agent, agentCommand, agentArgs, windowsShell }) => {
      const store = window.__store
      if (!store) {
        throw new Error('Orca store is unavailable')
      }
      await store.getState().updateSettings({
        defaultTuiAgent: agent,
        agentCmdOverrides: { [agent]: agentCommand },
        agentDefaultArgs: { [agent]: agentArgs },
        ...(windowsShell ? { terminalWindowsShell: windowsShell } : {})
      })
    },
    {
      agent,
      agentCommand,
      agentArgs: options.agentArgs ?? '',
      windowsShell: options.windowsShell ?? null
    }
  )
}

export async function launchGoldenStubAgentFromNewTab(
  page: Page,
  menuItemName: RegExp = /^Codex(?:\s|$)/i
): Promise<void> {
  await page.getByRole('button', { name: 'New tab' }).click({ force: true })
  const launchOption = page.getByRole('menuitem', { name: menuItemName }).first()
  await expect(launchOption).toBeVisible({ timeout: 15_000 })
  await launchOption.click({ force: true })
  await focusActiveTerminalInput(page)
  await waitForTerminalOutput(page, GOLDEN_STUB_READY_MARKER, 20_000)
}
