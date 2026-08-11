import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { DaemonClient } from '../../src/main/daemon/client'
import { getDaemonSocketPath, getDaemonTokenPath } from '../../src/main/daemon/daemon-spawner'
import { expect, test } from './helpers/orca-app'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient
} from './helpers/paired-electron-client'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'

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

function createRemovalTestRepo(): string {
  const repoPath = mkdtempSync(path.join(os.tmpdir(), 'orca-project-removal-repo-'))
  execFileSync('git', ['init'], { cwd: repoPath, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], {
    cwd: repoPath,
    stdio: 'ignore'
  })
  execFileSync('git', ['config', 'user.name', 'E2E Test'], {
    cwd: repoPath,
    stdio: 'ignore'
  })
  writeFileSync(path.join(repoPath, 'README.md'), '# Project removal E2E\n')
  execFileSync('git', ['add', 'README.md'], { cwd: repoPath, stdio: 'ignore' })
  execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: repoPath, stdio: 'ignore' })
  return repoPath
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

async function spawnDetachedDaemonSession(
  userDataDir: string,
  worktreeId: string,
  cwd: string,
  command: string
): Promise<{ client: DaemonClient; sessionId: string }> {
  const runtimeDir = path.join(userDataDir, 'daemon')
  const client = new DaemonClient({
    socketPath: getDaemonSocketPath(runtimeDir),
    tokenPath: getDaemonTokenPath(runtimeDir)
  })
  await client.ensureConnected()
  const sessionId = `${worktreeId}@@${randomUUID()}`
  await client.request('createOrAttach', {
    sessionId,
    cols: 120,
    rows: 40,
    cwd,
    command,
    launchAgent: 'codex'
  })
  return { client, sessionId }
}

test('removing a local project stops a sleeping PTY known only by its durable wake hint', async ({
  electronApp,
  orcaPage,
  testRepoPath
}) => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'orca-local-project-removal-'))
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

  let daemonSession: Awaited<ReturnType<typeof spawnDetachedDaemonSession>> | undefined
  let pid = 0
  try {
    const owner = await orcaPage.evaluate((repoPath) => {
      const repo = window.__store?.getState().repos.find((candidate) => candidate.path === repoPath)
      if (!repo) {
        throw new Error('local fixture project is unavailable')
      }
      return { repoId: repo.id }
    }, testRepoPath)
    const sleepingWorktreeId = `${owner.repoId}::${path.join(testRepoPath, 'sleeping-agent')}`
    const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
    daemonSession = await spawnDetachedDaemonSession(
      userDataDir,
      sleepingWorktreeId,
      testRepoPath,
      fixtureCommand(fixturePath, markerPath)
    )
    await expect.poll(() => readPid(markerPath), { timeout: 20_000 }).toBeGreaterThan(0)
    pid = readPid(markerPath)

    const hintState = await orcaPage.evaluate(
      ({ repoId, worktreeId, ptyId }) => {
        const store = window.__store
        if (!store) {
          throw new Error('local renderer store is unavailable')
        }
        const tabId = 'sleeping-project-removal-tab'
        store.setState((state) => ({
          tabsByWorktree: {
            ...state.tabsByWorktree,
            [worktreeId]: [{ id: tabId, worktreeId, title: 'Sleeping Agent' } as never]
          },
          ptyIdsByTabId: { ...state.ptyIdsByTabId, [tabId]: [] },
          lastKnownRelayPtyIdByTabId: {
            ...state.lastKnownRelayPtyIdByTabId,
            [tabId]: ptyId
          }
        }))
        const tab = store.getState().tabsByWorktree[worktreeId]?.[0]
        return {
          repoPresent: store.getState().repos.some((repo) => repo.id === repoId),
          tabPtyId: tab?.ptyId ?? null,
          livePtyIds: store.getState().ptyIdsByTabId[tabId] ?? [],
          wakeHint: store.getState().lastKnownRelayPtyIdByTabId[tabId]
        }
      },
      { repoId: owner.repoId, worktreeId: sleepingWorktreeId, ptyId: daemonSession.sessionId }
    )
    expect(hintState).toEqual({
      repoPresent: true,
      tabPtyId: null,
      livePtyIds: [],
      wakeHint: daemonSession.sessionId
    })
    expect(isProcessAlive(pid)).toBe(true)

    await orcaPage.evaluate(async (repoId) => {
      await window.__store?.getState().removeProject(repoId)
    }, owner.repoId)

    await expect(orcaPage.getByText('No workspaces found', { exact: true })).toBeVisible({
      timeout: 20_000
    })
    await expect.poll(() => isProcessAlive(pid), { timeout: 20_000 }).toBe(false)
  } finally {
    if (daemonSession) {
      await daemonSession.client
        .request('kill', { sessionId: daemonSession.sessionId, immediate: true })
        .catch(() => undefined)
      daemonSession.client.disconnect()
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

test('removing a project stops its headed remote-runtime PTYs @headful', async ({
  electronApp,
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

  let daemonSession: Awaited<ReturnType<typeof spawnDetachedDaemonSession>> | undefined
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

    const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
    const sleepingWorktreeId = `${owner.repoId}::${path.join(testRepoPath, 'sleeping-agent')}`
    daemonSession = await spawnDetachedDaemonSession(
      userDataDir,
      sleepingWorktreeId,
      testRepoPath,
      fixtureCommand(fixturePath, markerPath)
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

    await expect(client.page.getByText('No workspaces found', { exact: true })).toBeVisible({
      timeout: 20_000
    })
    await expect.poll(() => isProcessAlive(pid), { timeout: 20_000 }).toBe(false)
  } finally {
    await client?.dispose().catch(() => undefined)
    if (daemonSession) {
      await daemonSession.client
        .request('kill', { sessionId: daemonSession.sessionId, immediate: true })
        .catch(() => undefined)
      daemonSession.client.disconnect()
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

test('removing a project stops its headless remote-runtime PTYs @headful', async ({
  testRepoPath: _testRepoPath
}, testInfo) => {
  test.setTimeout(180_000)
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'orca-headless-project-removal-'))
  const markerPath = path.join(scratch, 'agent.pid')
  const fixturePath = path.join(scratch, 'agent-fixture.cjs')
  const testRepoPath = createRemovalTestRepo()
  writeFileSync(
    fixturePath,
    [
      "require('node:fs').writeFileSync(process.argv[2], String(process.pid))",
      "process.stdout.write('READY\\r\\n')",
      'setInterval(() => {}, 1_000)'
    ].join('\n')
  )

  const host = await launchHeadlessPairedRuntimeHost()
  let pid = 0
  let daemonSession: Awaited<ReturnType<typeof spawnDetachedDaemonSession>> | undefined
  let client: Awaited<ReturnType<typeof launchPairedElectronClient>> | undefined
  try {
    const added = await host.client.call<{ repo: { id: string; path: string } }>('repo.add', {
      path: testRepoPath,
      kind: 'git'
    })
    daemonSession = await spawnDetachedDaemonSession(
      host.userDataDir,
      `${added.result.repo.id}::${path.join(added.result.repo.path, 'sleeping-agent')}`,
      added.result.repo.path,
      fixtureCommand(fixturePath, markerPath)
    )

    await expect.poll(() => readPid(markerPath), { timeout: 20_000 }).toBeGreaterThan(0)
    pid = readPid(markerPath)
    client = await launchPairedElectronClient(host.offer, testInfo, 'headless-project-removal-host')
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
            return Boolean(repo)
          }, added.result.repo.id) ?? false,
        { timeout: 30_000 }
      )
      .toBe(true)

    await client.page.evaluate(async (repoId) => {
      await window.__store?.getState().removeProject(repoId)
    }, added.result.repo.id)

    await expect(client.page.getByText('No workspaces found', { exact: true })).toBeVisible({
      timeout: 20_000
    })
    await expect.poll(() => isProcessAlive(pid), { timeout: 20_000 }).toBe(false)
  } finally {
    await client?.dispose().catch(() => undefined)
    if (daemonSession) {
      await daemonSession.client
        .request('kill', { sessionId: daemonSession.sessionId, immediate: true })
        .catch(() => undefined)
      daemonSession.client.disconnect()
    }
    await host.dispose()
    if (isProcessAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // Already exited.
      }
    }
    rmSync(scratch, { recursive: true, force: true })
    rmSync(testRepoPath, { recursive: true, force: true })
  }
})
