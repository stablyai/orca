import { readWindowsProcessTableFresh } from '../../../src/main/windows/windows-process-table'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'
import { focusActiveTerminalInput, waitForTerminalOutput } from './terminal'
import type { BuiltInWindowsTerminalShell } from '../../../src/shared/windows-terminal-shell'

export const GOLDEN_STUB_READY_MARKER = 'GOLDEN_STUB_AGENT_READY'
export const GOLDEN_STUB_EXIT_MARKER = 'GOLDEN_STUB_AGENT_EXITED'

/** Agents exposed by the fixture directory for tab-bar detection. */
export const GOLDEN_STUB_AGENTS = [
  { id: 'codex', menuItemName: /^Codex(?:\s|$)/i },
  { id: 'claude', menuItemName: /^Claude(?:\s|$)/i }
] as const

const fixtureDir = path.join(process.cwd(), 'tests', 'e2e', 'fixtures', 'golden-stub-agent')

export function getGoldenStubAgentLaunchEnv(): NodeJS.ProcessEnv {
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH'
  return {
    [pathKey]: [fixtureDir, process.env[pathKey] ?? ''].filter(Boolean).join(path.delimiter)
  }
}

export async function configureGoldenStubAgent(
  page: Page,
  options: {
    agent?: (typeof GOLDEN_STUB_AGENTS)[number]['id']
    agentArgs?: string
    /** Windows default shell the launch command must survive; ignored elsewhere. */
    windowsShell?: BuiltInWindowsTerminalShell
  } = {}
): Promise<void> {
  const agent = options.agent ?? 'codex'
  await page.evaluate(
    async ({ agent, agentArgs, windowsShell }) => {
      const store = window.__store
      if (!store) {
        throw new Error('Orca store is unavailable')
      }
      await store.getState().updateSettings({
        defaultTuiAgent: agent,
        agentCmdOverrides: { [agent]: 'golden-stub-agent' },
        agentDefaultArgs: { [agent]: agentArgs },
        ...(windowsShell ? { terminalWindowsShell: windowsShell } : {})
      })
    },
    { agent, agentArgs: options.agentArgs ?? '', windowsShell: options.windowsShell ?? null }
  )
}

export async function launchGoldenStubAgentFromNewTab(
  page: Page,
  menuItemName: RegExp = /^Codex(?:\s|$)/i
): Promise<void> {
  let previous = ''
  let reading = false
  const sample = async (): Promise<void> => {
    if (process.platform !== 'win32' || reading) return
    reading = true
    try {
      const rows = await readWindowsProcessTableFresh()
      const ids = new Set(rows.filter((row) => /^(?:sh|bash)\.exe$/i.test(row.name) || /golden-stub/.test(row.command)).map((row) => row.pid))
      for (let depth = 0; depth < 5; depth++) {
        for (const row of rows) if (ids.has(row.pid)) ids.add(row.ppid)
      }
      const state = JSON.stringify(rows.filter((row) => ids.has(row.pid)))
      if (state !== previous) console.error('LAUNCH_PROCESS_TREE', state)
      previous = state
    } finally { reading = false }
  }
  const timer = setInterval(() => { void sample() }, 100)
  try {
  await sample()
  await page.getByRole('button', { name: 'New tab' }).click({ force: true })
  const launchOption = page.getByRole('menuitem', { name: menuItemName }).first()
  await expect(launchOption).toBeVisible({ timeout: 15_000 })
  await launchOption.click({ force: true })
  await focusActiveTerminalInput(page)
  await waitForTerminalOutput(page, GOLDEN_STUB_READY_MARKER, 20_000)
  } finally { clearInterval(timer); await sample() }
}
