/**
 * Invariant: an `agent.launch.before` plugin that lists `launchKinds: ["resume"]` runs on a resumed
 * Claude launch (its env applies; Orca keeps its own command) and not on a new launch or a restore,
 * through the real window spawn wiring.
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
import { expect } from '@stablyai/playwright-test'
import { test } from '../desktop/electron-fixtures/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from '../desktop/renderer-probes/store'
import { disablePluginSystem, enableDevPlugins } from './plugin-smoke'

const stage = mkdtempSync(join(tmpdir(), 'orca-launch-kinds-e2e-'))
const binDir = join(stage, 'bin')
const pluginDir = join(stage, 'plugin')
const markerPath = join(stage, 'claude-run.txt')
mkdirSync(binDir)
mkdirSync(pluginDir)

// Why a real `claude` on PATH: the pane's shell function routes only to an executable `claude`.
writeFileSync(
  join(binDir, 'claude'),
  [
    '#!/bin/sh',
    'case " $* " in *" --version "*) echo "2.1.200 (Claude Code)"; exit 0;; esac',
    `printf '%s|%s' "\${FROM_PLUGIN-unset}" "$*" > '${markerPath}'`,
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
    id: 'e2e-launch-kinds',
    name: 'E2E Launch Kinds',
    version: '1.0.0',
    description: 'Marks resumed agent launches.',
    engines: { orca: '>=1.4.262' },
    pluginApi: 1,
    main: 'main.mjs',
    contributes: { hooks: [{ event: 'agent.launch.before', launchKinds: ['resume'] }] }
  })
)
writeFileSync(
  join(pluginDir, 'main.mjs'),
  `export default async function activate(orca) {
  orca.hooks.on('agent.launch.before', (event, next) =>
    next({ ...event, command: event.command + ' --rewritten', env: { FROM_PLUGIN: event.launchKind } })
  )
}
`
)

test.use({ orcaAppExtraEnv: { PATH: `${binDir}:${process.env.PATH ?? '/usr/bin:/bin'}` } })
test.afterAll(() => rmSync(stage, { recursive: true, force: true }))

/** What the stand-in Claude saw: `<FROM_PLUGIN>|kept` or `<FROM_PLUGIN>|rewritten` (Orca adds its own
 *  arguments, so only the plugin's change is compared); the terminal is closed after. */
async function launchOutcome(
  page: Page,
  worktreeId: string,
  start: { spawnIntent?: 'user-resume' | 'automatic-restore'; resumeOrigin?: 'saved' }
): Promise<string> {
  rmSync(markerPath, { force: true })
  const id = await page.evaluate(
    async ({ cwd, worktreeId, start }) =>
      (
        await window.api.pty.spawn({
          cols: 120,
          rows: 40,
          cwd,
          command: 'claude --session e2e',
          launchAgent: 'claude',
          worktreeId,
          ...start
        })
      ).id,
    { cwd: stage, worktreeId, start }
  )
  try {
    await expect.poll(() => existsSync(markerPath), { timeout: 30_000 }).toBe(true)
    const [env, args = ''] = readFileSync(markerPath, 'utf8').split('|')
    return `${env}|${args.includes('--rewritten') ? 'rewritten' : 'kept'}`
  } finally {
    await page.evaluate((ptyId) => window.api.pty.kill(ptyId), id)
  }
}

test("a launch plugin that lists resume runs only on resumed launches, and keeps Orca's command", async ({
  orcaPage
}) => {
  test.skip(process.platform === 'win32', 'the stand-in claude is a POSIX script')
  // Why: one Electron launch, a plugin worker start and three terminals.
  test.setTimeout(120_000)
  await waitForSessionReady(orcaPage)
  const worktreeId = await waitForActiveWorktree(orcaPage)
  await enableDevPlugins(orcaPage, [pluginDir])
  try {
    // Why poll: enabling plugins queues refreshes, and a launch during one skips the hook.
    await expect
      .poll(() => launchOutcome(orcaPage, worktreeId, { spawnIntent: 'user-resume' }), {
        timeout: 60_000
      })
      .toBe('resume|kept')
    expect(await launchOutcome(orcaPage, worktreeId, {})).toBe('unset|kept')
    expect(
      await launchOutcome(orcaPage, worktreeId, {
        spawnIntent: 'automatic-restore',
        resumeOrigin: 'saved'
      })
    ).toBe('unset|kept')
  } finally {
    await disablePluginSystem(orcaPage)
  }
})
