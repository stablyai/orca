/**
 * Invariant: an `agent.launch.before` plugin that sets `accountId` runs Claude on that saved
 * account's folder, through the real spawn wiring, and an id Orca does not have is refused.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { CLAUDE_CHOSEN_ACCOUNT_UNKNOWN_MESSAGE } from '../../src/shared/agent-accounts/claude/claude-profile-routing'
import { expect, test } from './helpers/orca-app'
import { disablePluginSystem, enableDevPlugins } from './helpers/plugin-smoke'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

const stage = mkdtempSync(join(tmpdir(), 'orca-launch-account-e2e-'))
const binDir = join(stage, 'bin')
const pluginDir = join(stage, 'plugin')
const markerPath = join(stage, 'claude-config-dir.txt')
mkdirSync(binDir)
mkdirSync(pluginDir)

// Why a real `claude` on PATH: the pane's shell function routes only to an executable `claude`.
writeFileSync(
  join(binDir, 'claude'),
  [
    '#!/bin/sh',
    'case " $* " in *" --version "*) echo "2.1.200 (Claude Code)"; exit 0;; esac',
    `printf '%s' "\${CLAUDE_CONFIG_DIR-unset}" > '${markerPath}'`,
    'exec sleep 600',
    ''
  ].join('\n')
)
chmodSync(join(binDir, 'claude'), 0o755)

writeFileSync(
  join(pluginDir, 'orca-plugin.json'),
  JSON.stringify({
    manifestVersion: 2,
    execution: 'trusted-worker',
    id: 'e2e-launch-account',
    name: 'E2E Launch Account',
    version: '1.0.0',
    description: 'Chooses a saved Claude account for agent launches.',
    engines: { orca: '>=1.4.262' },
    pluginApi: 1,
    main: 'main.mjs',
    contributes: { hooks: [{ event: 'agent.launch.before', onError: 'deny' }] }
  })
)
writeFileSync(
  join(pluginDir, 'main.mjs'),
  `export default async function activate(orca) {
  orca.hooks.on('agent.launch.before', (event, next) =>
    next({ ...event, accountId: event.command.includes('--unknown-account') ? 'nope' : 'acct-b' })
  )
}
`
)

test.use({ orcaAppExtraEnv: { PATH: `${binDir}:${process.env.PATH ?? '/usr/bin:/bin'}` } })
test.afterAll(() => rmSync(stage, { recursive: true, force: true }))

function savedAccount(id: string) {
  return {
    id,
    email: `${id}@example.test`,
    authMethod: 'subscription-oauth' as const,
    managedAuthPath: '/unused-legacy',
    createdAt: 0,
    updatedAt: 0,
    lastAuthenticatedAt: 0
  }
}

const UNKNOWN_ACCOUNT = CLAUDE_CHOSEN_ACCOUNT_UNKNOWN_MESSAGE

/** The folder a launch's Claude ran on, or `refused: <reason>`; the stand-in is closed after. */
async function launchOutcome(page: Page, command: string, worktreeId: string): Promise<string> {
  rmSync(markerPath, { force: true })
  const spawned = await page.evaluate(
    async ({ cwd, command, worktreeId }) => {
      try {
        const { id } = await window.api.pty.spawn({
          cols: 120,
          rows: 40,
          cwd,
          command,
          launchAgent: 'claude',
          worktreeId
        })
        return { id }
      } catch (error) {
        return { refused: error instanceof Error ? error.message : String(error) }
      }
    },
    { cwd: stage, command, worktreeId }
  )
  const { id, refused } = spawned
  if (id === undefined) {
    const reason = refused ?? 'no terminal'
    return reason.includes(UNKNOWN_ACCOUNT) ? 'refused: unknown account' : reason
  }
  try {
    await expect.poll(() => existsSync(markerPath), { timeout: 30_000 }).toBe(true)
    return readFileSync(markerPath, 'utf8')
  } finally {
    await page.evaluate((ptyId) => window.api.pty.kill(ptyId), id)
  }
}

test('a launch plugin runs Claude on the saved account it chose', async ({
  electronApp,
  orcaPage
}) => {
  test.skip(process.platform === 'win32', 'the stand-in claude is a POSIX script')
  // Why: one Electron launch, a plugin worker start and a Claude account setup.
  test.setTimeout(120_000)
  const userData = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  await waitForSessionReady(orcaPage)
  const worktreeId = await waitForActiveWorktree(orcaPage)
  await orcaPage.evaluate(
    async (accounts) => {
      const settings = await window.api.settings.set({
        claudeManagedAccounts: accounts,
        activeClaudeManagedAccountId: 'acct-a'
      })
      window.__store?.setState({ settings })
    },
    [savedAccount('acct-a'), savedAccount('acct-b')]
  )
  await enableDevPlugins(orcaPage, [pluginDir])
  try {
    // Why poll: enabling plugins queues refreshes, and a launch during one skips or refuses the hook.
    await expect
      .poll(() => launchOutcome(orcaPage, 'claude', worktreeId), { timeout: 60_000 })
      .toBe(join(userData, 'claude-profiles', 'acct-b', 'home'))
    await expect
      .poll(() => launchOutcome(orcaPage, 'claude --unknown-account', worktreeId), {
        timeout: 60_000
      })
      .toBe('refused: unknown account')
  } finally {
    await disablePluginSystem(orcaPage)
  }
})
