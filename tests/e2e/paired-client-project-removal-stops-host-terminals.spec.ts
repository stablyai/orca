// Stop paired-project shells before repo.rm: terminal.stop resolves through workspace rows that removal otherwise deletes.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { TEST_REPO_PATH_FILE } from './global-setup'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import { createRestartSession } from './helpers/orca-restart'

function seededRepoPathOrSkip(): string {
  const repoPath = existsSync(TEST_REPO_PATH_FILE)
    ? readFileSync(TEST_REPO_PATH_FILE, 'utf8').trim()
    : ''
  test.skip(!repoPath || !existsSync(repoPath), 'Global setup did not produce a seeded test repo')
  return repoPath
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readShellPid(markerPath: string): number | null {
  if (!existsSync(markerPath)) {
    return null
  }
  const pid = Number.parseInt(readFileSync(markerPath, 'utf8').trim(), 10)
  return Number.isFinite(pid) && pid > 0 ? pid : null
}

async function callRuntime<TResult>(
  page: Page,
  environmentId: string,
  method: string,
  params: unknown
): Promise<TResult> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test-only RPC result shape.
  return page.evaluate(
    async ({ environmentId, method, params }) => {
      const response = await window.api.runtimeEnvironments.call({
        selector: environmentId,
        method,
        params
      })
      if (!response.ok) {
        throw new Error(`${response.error.code}: ${response.error.message}`)
      }
      return response.result
    },
    { environmentId, method, params }
  ) as Promise<TResult>
}

test('removing a project from a paired client stops its shells on the host', async (// oxlint-disable-next-line no-empty-pattern -- This test owns its host launch.
{}, testInfo) => {
  test.skip(process.platform === 'win32', 'reads the shell pid through POSIX `sh`')
  test.setTimeout(240_000)
  const repoPath = seededRepoPathOrSkip()
  const stage = mkdtempSync(join(tmpdir(), 'orca-project-removal-'))
  const markerPath = join(stage, 'shell.pid')
  const session = createRestartSession(testInfo)
  let host: ElectronApplication | null = null
  let client: PairedElectronClient | null = null
  let shellPid: number | null = null
  try {
    const launched = await session.launch()
    host = launched.app
    client = await launchPairedElectronClient(
      await createRuntimeDesktopPairingOffer(launched.page),
      testInfo,
      'project-removal-host-terminals'
    )
    const paired = client
    const added = await callRuntime<{ repo: { id: string } }>(
      paired.page,
      paired.environmentId,
      'repo.add',
      { path: repoPath, kind: 'git' }
    )
    const findWorktreeId = (): Promise<string | null> =>
      paired.page.evaluate(
        (repoId) =>
          window.__store
            ?.getState()
            .allWorktrees()
            .find((worktree) => worktree.repoId === repoId)?.id ?? null,
        added.repo.id
      )
    await expect
      .poll(findWorktreeId, { timeout: 60_000, message: 'Paired client never saw the worktree' })
      .not.toBeNull()
    const worktreeId = (await findWorktreeId()) ?? ''

    await paired.page.evaluate((id) => {
      const state = window.__store?.getState()
      state?.setActiveView('terminal')
      state?.setActiveWorktree(id)
    }, worktreeId)
    const listHostTerminals = (): Promise<string[]> =>
      callRuntime<{ terminals: { handle: string }[] }>(
        paired.page,
        paired.environmentId,
        'terminal.list',
        { worktree: `id:${worktreeId}` }
      ).then((listed) => listed.terminals.map((terminal) => terminal.handle))
    await expect
      .poll(() => listHostTerminals().then((handles) => handles.length), {
        timeout: 45_000,
        message: 'Opening the worktree never created a host terminal'
      })
      .toBeGreaterThan(0)
    const [handle] = await listHostTerminals()

    // Retried because the first send can land before the shell is writable or has its prompt.
    await expect
      .poll(
        async () => {
          await callRuntime(paired.page, paired.environmentId, 'terminal.send', {
            terminal: handle,
            // Why sh: `$$` is not portable to fish; sh's $PPID is the pane shell in any login shell.
            text: `sh -c 'echo $PPID > "${markerPath}"'`,
            enter: true
          }).catch(() => undefined)
          return readShellPid(markerPath)
        },
        { timeout: 30_000, intervals: [1_000], message: 'The host shell never reported its pid' }
      )
      .not.toBeNull()
    shellPid = readShellPid(markerPath)
    expect(shellPid !== null && isProcessAlive(shellPid)).toBe(true)

    const hostId = await paired.page.evaluate(
      (repoId) =>
        window.__store?.getState().repos.find((repo) => repo.id === repoId)?.executionHostId ??
        null,
      added.repo.id
    )
    expect(hostId).toMatch(/^runtime:/)
    if (!hostId) {
      throw new Error('The paired client has no host row for the project')
    }
    await paired.page.evaluate(
      ({ repoId, hostId }) => window.__store?.getState().removeProject(repoId, { hostId }),
      { repoId: added.repo.id, hostId }
    )

    await expect
      .poll(() => shellPid !== null && isProcessAlive(shellPid), {
        timeout: 30_000,
        message: 'The host shell kept running after its project was removed'
      })
      .toBe(false)
  } finally {
    if (shellPid !== null && isProcessAlive(shellPid)) {
      process.kill(shellPid, 'SIGKILL')
    }
    if (client) {
      await client.dispose()
    }
    if (host) {
      await session.close(host)
    }
    await session.dispose()
    rmSync(stage, { recursive: true, force: true })
  }
})
