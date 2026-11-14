import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient
} from './helpers/paired-electron-client'

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function fixtureCommand(scriptPath: string, markerPath: string): string {
  const command = [process.execPath, scriptPath, markerPath]
  return process.platform === 'win32'
    ? command.map((value) => `"${value.replaceAll('"', '""')}"`).join(' ')
    : command.map(shellQuote).join(' ')
}

function readPid(markerPath: string): number {
  return existsSync(markerPath) ? Number(readFileSync(markerPath, 'utf8').trim()) : 0
}

function isProcessAlive(pid: number): boolean {
  if (pid <= 0) {
    return false
  }
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

test('removing a project stops its headed remote-runtime PTYs @headful', async ({
  orcaPage,
  testRepoPath
}, testInfo) => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'orca-remote-project-removal-'))
  const markerPath = path.join(scratch, 'agent.pid')
  const fixturePath = path.join(scratch, 'agent-fixture.cjs')
  writeFileSync(
    fixturePath,
    [
      "require('node:fs').writeFileSync(process.argv[2], String(process.pid))",
      "process.stdout.write('READY\\r\\n')",
      'setInterval(() => {}, 1_000)'
    ].join('\n')
  )

  let ptyId = ''
  let pid = 0
  let client: Awaited<ReturnType<typeof launchPairedElectronClient>> | undefined
  try {
    const owner = await orcaPage.evaluate((repoPath) => {
      const state = window.__store?.getState()
      const repo = state?.repos.find((candidate) => candidate.path === repoPath)
      const worktree = repo
        ? state?.worktreesByRepo[repo.id]?.find((candidate) => candidate.isMainWorktree)
        : undefined
      if (!repo || !worktree) {
        throw new Error('headed host fixture project is unavailable')
      }
      return { repoId: repo.id, worktreeId: worktree.id }
    }, testRepoPath)

    ptyId = await orcaPage.evaluate(
      async ({ command, cwd, worktreeId }) => {
        const result = await window.api.pty.spawn({
          cols: 120,
          rows: 40,
          command,
          cwd,
          initiallyHidden: true,
          launchAgent: 'codex',
          worktreeId
        })
        return result.id
      },
      {
        command: fixtureCommand(fixturePath, markerPath),
        cwd: testRepoPath,
        worktreeId: owner.worktreeId
      }
    )

    await expect.poll(() => readPid(markerPath), { timeout: 20_000 }).toBeGreaterThan(0)
    pid = readPid(markerPath)
    expect(isProcessAlive(pid)).toBe(true)

    client = await launchPairedElectronClient(
      await createRuntimeDesktopPairingOffer(orcaPage),
      testInfo,
      'project-removal-host'
    )
    await expect
      .poll(
        () =>
          client?.page.evaluate(async (repoId) => {
            const store = window.__store
            if (!store) {
              return false
            }
            await store.getState().fetchRepos()
            const repo = store.getState().repos.find((candidate) => candidate.id === repoId)
            if (!repo) {
              return false
            }
            await store.getState().fetchWorktrees(repo.id)
            return (store.getState().worktreesByRepo[repo.id]?.length ?? 0) > 0
          }, owner.repoId) ?? false,
        { timeout: 30_000 }
      )
      .toBe(true)

    await client.page.evaluate(async (repoId) => {
      const store = window.__store
      if (!store) {
        throw new Error('paired client store is unavailable')
      }
      await store.getState().removeProject(repoId)
    }, owner.repoId)

    await expect
      .poll(
        () =>
          client?.page.evaluate(
            (repoId) => !window.__store?.getState().repos.some((repo) => repo.id === repoId)
          ),
        { timeout: 20_000 }
      )
      .toBe(true)
    await expect.poll(() => isProcessAlive(pid), { timeout: 20_000 }).toBe(false)
  } finally {
    await client?.dispose().catch(() => undefined)
    if (ptyId) {
      await orcaPage.evaluate((id) => window.api.pty.kill(id), ptyId).catch(() => undefined)
    }
    if (isProcessAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // Already exited.
      }
    }
    rmSync(scratch, { recursive: true, force: true })
  }
})
