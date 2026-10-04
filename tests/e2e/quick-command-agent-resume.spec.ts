import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { TEST_REPO_PATH_FILE } from './global-setup'
import {
  getTerminalContent,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { stageNodeScriptForTerminal } from './helpers/run-node-script-in-terminal'
import { PROTOCOL_VERSION } from '../../src/main/daemon/types'
import { stripAnsiEscapeSequences } from '../../src/shared/ansi-escape-sequences'

const WRAPPER_MARKER = 'FAKE_WRAPPER_ARGV'
const ENV_MARKER = 'FAKE_WRAPPER_ENV'
const STOCK_MARKER = 'STOCK_CLAUDE'
const QUICK_COMMAND_ID = 'e2e-quick-command-wrapper'

// Why a node script: it stands in for a wrapper like `ccr muse` on every
// shell, printing the argv it was resumed with and the launch identity a later
// agent in the same shell would inherit; `--exit` makes it a non-agent command
// that finishes immediately.
const WRAPPER_SOURCE = `
const args = process.argv.slice(2)
const env = {
  paneKey: process.env.ORCA_PANE_KEY || '',
  launchToken: process.env.ORCA_AGENT_LAUNCH_TOKEN || '',
  tabId: process.env.ORCA_TAB_ID || '',
  worktreeId: process.env.ORCA_WORKTREE_ID || ''
}
process.stdout.write(${JSON.stringify(ENV_MARKER)} + JSON.stringify(env) + '\\n')
process.stdout.write(${JSON.stringify(WRAPPER_MARKER)} + JSON.stringify(args) + '\\n')
if (!args.includes('--exit')) setInterval(() => {}, 1 << 30)
`.trim()

function readDaemonPid(userDataDir: string): number {
  const raw = readFileSync(
    path.join(userDataDir, 'daemon', `daemon-v${PROTOCOL_VERSION}.pid`),
    'utf8'
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: pid is type-checked on the next line before use.
  const parsed = JSON.parse(raw) as { pid?: unknown }
  if (typeof parsed.pid !== 'number') {
    throw new Error(`Daemon pid file did not contain a numeric pid: ${raw}`)
  }
  return parsed.pid
}

async function runQuickCommandTab(page: Page, command: string, label: string): Promise<void> {
  await page.evaluate(
    async ({ command, label, id }) => {
      const store = window.__store
      if (!store) {
        throw new Error('Renderer store unavailable')
      }
      await store.getState().updateSettings({
        // Why: resolves the stock resume to an echo, so a fallback is visible
        // and never launches a real Claude CLI.
        agentCmdOverrides: { claude: 'echo STOCK_CLAUDE' },
        terminalQuickCommands: [
          {
            id,
            label,
            scope: { type: 'global' },
            action: 'terminal-command',
            command,
            appendEnter: true
          }
        ]
      })
    },
    { command, label, id: QUICK_COMMAND_ID }
  )
  const button = page.getByRole('button', { name: `Run quick command: ${label}` })
  await expect(button).toBeVisible()
  await button.click()
  await waitForTerminalOutput(page, WRAPPER_MARKER, 30_000)
}

type StampedPane = { paneKey: string; launchToken: string; tabId: string; worktreeId: string }

async function readStampedPane(page: Page): Promise<StampedPane | null> {
  return page.evaluate((id) => {
    const state = window.__store?.getState()
    if (!state) {
      return null
    }
    for (const [paneKey, entry] of Object.entries(state.agentLaunchConfigByPaneKey)) {
      if (entry.launchConfig.quickCommandId !== id || !entry.identity.launchToken) {
        continue
      }
      const tabId = entry.identity.tabId ?? paneKey.split(':')[0] ?? ''
      const worktreeId =
        Object.entries(state.tabsByWorktree).find(([, tabs]) =>
          tabs.some((tab) => tab.id === tabId)
        )?.[0] ?? ''
      return { paneKey, launchToken: entry.identity.launchToken, tabId, worktreeId }
    }
    return null
  }, QUICK_COMMAND_ID)
}

async function readWrapperEnv(page: Page): Promise<StampedPane> {
  await waitForTerminalOutput(page, ENV_MARKER, 30_000)
  const content = stripAnsiEscapeSequences(await getTerminalContent(page, 8000)).replace(
    /\r?\n/g,
    ''
  )
  const start = content.indexOf(ENV_MARKER) + ENV_MARKER.length
  const end = content.indexOf('}', start) + 1
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the staged wrapper above writes exactly this shape.
  const parsed = JSON.parse(content.slice(start, end)) as StampedPane
  if (!parsed.paneKey || !parsed.launchToken) {
    throw new Error(`Quick Command pane has no launch identity: ${content.slice(start, end)}`)
  }
  return parsed
}

// Why: a real agent reports its provider session over the hook server with
// the pane's launch token; seeding the same store write keeps this hermetic.
async function reportClaudeSession(
  page: Page,
  pane: StampedPane,
  sessionId: string
): Promise<void> {
  await page.evaluate(
    ({ pane, sessionId }) => {
      window.__store
        ?.getState()
        .setAgentStatus(
          pane.paneKey,
          { state: 'working', prompt: 'finish the task', agentType: 'claude' },
          'Claude',
          undefined,
          { worktreeId: pane.worktreeId, tabId: pane.tabId },
          { providerSession: { key: 'session_id', id: sessionId }, launchToken: pane.launchToken }
        )
    },
    { pane, sessionId }
  )
}

async function restartAfterDaemonDeath(
  session: ReturnType<typeof createRestartSession>,
  app: ElectronApplication
): Promise<{ app: ElectronApplication; page: Page }> {
  const daemonPid = readDaemonPid(session.userDataDir)
  await session.close(app)
  // Why: the daemon (and the agent inside it) dying while Orca is closed is
  // what forces the cold-restore resume path this PR changes.
  process.kill(daemonPid, 'SIGKILL')
  const relaunch = await session.launch()
  await waitForSessionReady(relaunch.page)
  await ensureTerminalVisible(relaunch.page)
  await waitForActiveTerminalManager(relaunch.page, 30_000)
  return relaunch
}

test.describe.configure({ mode: 'serial' })

test.describe('Quick Command agent resume', () => {
  for (const scenario of ['wrapper', 'retired'] as const) {
    test(`resume after restart: ${scenario}`, async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
    {}, testInfo) => {
      const repoPath = readFileSync(TEST_REPO_PATH_FILE, 'utf-8').trim()
      if (!repoPath || !existsSync(repoPath)) {
        test.skip(true, 'Global setup did not produce a seeded test repo')
        return
      }
      const session = createRestartSession(testInfo)
      const staged = stageNodeScriptForTerminal(WRAPPER_SOURCE, { prefix: 'orca-e2e-qc-wrapper' })
      const sessionId = `e2e-qc-${scenario}-${Date.now()}`
      let firstApp: ElectronApplication | null = null
      let secondApp: ElectronApplication | null = null
      try {
        const first = await session.launch()
        firstApp = first.app
        await attachRepoAndOpenTerminal(first.page, repoPath)
        await waitForSessionReady(first.page)
        await waitForActiveWorktree(first.page)
        await ensureTerminalVisible(first.page)
        await waitForActiveTerminalManager(first.page, 30_000)

        const quickCommandText =
          scenario === 'wrapper'
            ? `${staged.command} --resume`
            : `${staged.command} --exit --resume`
        await runQuickCommandTab(first.page, quickCommandText, `QC ${scenario}`)

        // Why from the shell env: it is exactly what a later agent in this
        // shell inherits, and it outlives the registry entry under test.
        const stamped = await readWrapperEnv(first.page)
        if (scenario === 'retired') {
          // The non-agent command exited (OSC 133 D) — its unused link must go.
          await expect.poll(async () => readStampedPane(first.page), { timeout: 15_000 }).toBeNull()
        }
        // Wrapper: the agent the Quick Command launched binds its session.
        // Retired: an agent started by hand later inherits the pane's token.
        await reportClaudeSession(first.page, stamped, sessionId)

        const relaunch = await restartAfterDaemonDeath(session, firstApp)
        firstApp = null
        secondApp = relaunch.app
        await waitForTerminalOutput(relaunch.page, sessionId, 30_000)
        const restored = await getTerminalContent(relaunch.page, 8000)
        if (scenario === 'wrapper') {
          expect(restored).toContain(`${WRAPPER_MARKER}["--resume","${sessionId}"]`)
        } else {
          // Why whole-buffer: PowerShell's echo prints each argument on its
          // own line, and an argv-embedded startup command is never echoed.
          expect(restored).toContain(STOCK_MARKER)
          expect(restored).not.toContain(`${WRAPPER_MARKER}["--resume","${sessionId}"]`)
        }
      } finally {
        if (secondApp) {
          await session.close(secondApp)
        }
        if (firstApp) {
          await session.close(firstApp)
        }
        await session.dispose()
        staged.cleanup()
      }
    })
  }
})
