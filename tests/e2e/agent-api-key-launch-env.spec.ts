import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

const KEY = 'sk-ant-api03-e2e-agent-key-launch-env-0042'

// A stored agent API key reaches that agent's process as env, and nothing else.
test('a stored API key is handed to the agent launch only', async ({ orcaPage, electronApp }) => {
  test.skip(process.platform === 'win32', 'stand-in agent is a POSIX script')

  const stage = mkdtempSync(join(tmpdir(), 'orca-agent-api-key-'))
  const agentOut = join(stage, 'agent-env.txt')
  const shellOut = join(stage, 'shell-env.txt')
  const fakeAgent = join(stage, 'claude')
  writeFileSync(
    fakeAgent,
    `#!/bin/sh\nprintf '%s' "\${ANTHROPIC_API_KEY:-unset}" > '${agentOut}'\nsleep 30\n`
  )
  chmodSync(fakeAgent, 0o755)
  try {
    await waitForSessionReady(orcaPage)
    const worktreeId = await waitForActiveWorktree(orcaPage)
    // Headless Linux CI has no keyring; Orca correctly refuses to store keys there.
    const protection = await orcaPage.evaluate(
      async () => (await window.api.agentApiKeys!.list()).protection
    )
    test.skip(!protection.available, 'no OS keychain that really seals on this runner')

    const saved = await orcaPage.evaluate(
      (value) =>
        window.api.agentApiKeys!.save({
          agent: 'claude',
          envName: 'ANTHROPIC_API_KEY',
          value,
          hostScope: { kind: 'all' }
        }),
      KEY
    )
    expect(saved.ok).toBe(true)
    // The renderer only ever sees the hint.
    expect(JSON.stringify(saved)).not.toContain(KEY)

    await orcaPage.evaluate(
      async ({ command, cwd, worktreeId: wt }) => {
        await window.api.pty.spawn({
          cols: 100,
          rows: 30,
          cwd,
          command,
          launchAgent: 'claude',
          worktreeId: wt
        })
      },
      { command: `'${fakeAgent}'`, cwd: stage, worktreeId }
    )
    await expect
      .poll(() => existsSync(agentOut) && readFileSync(agentOut, 'utf8'), { timeout: 20_000 })
      .toBe(KEY)

    // A plain terminal is not an agent launch.
    await orcaPage.evaluate(
      async ({ command, cwd, worktreeId: wt }) => {
        await window.api.pty.spawn({ cols: 100, rows: 30, cwd, command, worktreeId: wt })
      },
      {
        command: `printf '%s' "\${ANTHROPIC_API_KEY:-unset}" > '${shellOut}'`,
        cwd: stage,
        worktreeId
      }
    )
    await expect
      .poll(() => existsSync(shellOut) && readFileSync(shellOut, 'utf8'), { timeout: 20_000 })
      .not.toBe(false)
    expect(readFileSync(shellOut, 'utf8')).not.toBe(KEY)

    const userData = await electronApp.evaluate(({ app }) => app.getPath('userData'))
    expect(readFileSync(join(userData, 'agent-api-keys.json'), 'utf8')).not.toContain(KEY)
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
})
