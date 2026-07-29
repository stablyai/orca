import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// Reproduces the orphaned-descendant battery-drain incident (STA-1800): an
// agent CLI spawns a tool child in a detached process group, the session is
// killed, and the child must not survive. The stand-in agent's first command
// token is literally `claude` so PTY spawn recognition marks the session as an
// agent; tab close → pty.kill routing is already covered by
// terminal-parked-close-retirement.spec.ts, so this spec drives pty.kill.
test('killing an agent PTY terminates its detached-pgid descendants', async ({ orcaPage }) => {
  test.skip(process.platform === 'win32', 'descendant tree-kill is POSIX-only for now')

  const stage = mkdtempSync(join(tmpdir(), 'orca-agent-descendant-'))
  const markerPath = join(stage, 'detached-child.pid')
  const spawnerPath = join(stage, 'spawn-detached.cjs')
  writeFileSync(
    spawnerPath,
    [
      "const { spawn } = require('node:child_process')",
      // detached:true → setsid → own pgid/session, exactly the topology of an
      // agent CLI's tool subprocess that a dying shell's SIGHUP cannot reach.
      "const child = spawn('sleep', ['31337'], { detached: true, stdio: 'ignore' })",
      'child.unref()',
      "require('node:fs').writeFileSync(process.argv[2], String(child.pid))",
      // Stay alive like a real agent at its prompt: the detached child's ppid
      // must remain intact at kill time — a pre-orphaned child is the separate
      // crash-path scenario that only the PR-2 sweep can catch.
      'setInterval(() => {}, 1000)',
      ''
    ].join('\n')
  )
  const fakeAgentPath = join(stage, 'claude')
  writeFileSync(fakeAgentPath, `#!/bin/sh\nexec "${process.execPath}" "${spawnerPath}" "$1"\n`)
  chmodSync(fakeAgentPath, 0o755)

  let detachedChildPid = 0
  try {
    await waitForSessionReady(orcaPage)
    const worktreeId = await waitForActiveWorktree(orcaPage)

    const ptyId = await orcaPage.evaluate(
      async ({ command, cwd, worktreeId: wt }) => {
        const result = await window.api.pty.spawn({
          cols: 120,
          rows: 40,
          cwd,
          command,
          launchAgent: 'claude',
          worktreeId: wt
        })
        return result.id
      },
      { command: `'${fakeAgentPath}' '${markerPath}'`, cwd: stage, worktreeId }
    )
    expect(ptyId).toBeTruthy()

    await expect
      .poll(() => existsSync(markerPath), {
        timeout: 20_000,
        message: 'stand-in agent never spawned its detached child'
      })
      .toBe(true)
    detachedChildPid = Number(readFileSync(markerPath, 'utf8').trim())
    expect(detachedChildPid).toBeGreaterThan(0)
    expect(isProcessAlive(detachedChildPid)).toBe(true)

    await orcaPage.evaluate((id) => window.api.pty.kill(id), ptyId)

    await expect
      .poll(() => isProcessAlive(detachedChildPid), {
        timeout: 15_000,
        message: `detached descendant ${detachedChildPid} survived the agent PTY kill`
      })
      .toBe(false)
  } finally {
    if (detachedChildPid > 0 && isProcessAlive(detachedChildPid)) {
      try {
        process.kill(detachedChildPid, 'SIGKILL')
      } catch {
        /* already gone */
      }
    }
    rmSync(stage, { recursive: true, force: true })
  }
})
