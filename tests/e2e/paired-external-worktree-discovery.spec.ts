import { rmSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { gitExecFileAsync } from '../../src/main/git/runner'
import { listWorktreesStrict } from '../../src/main/git/worktree'
import { areWorktreePathsEqual } from '../../src/main/ipc/worktree-path-comparison'
import { expect, test } from './helpers/orca-app'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import { worktreeRow } from './worktree-row-locators'

function equivalentTestPaths(value: string): string[] {
  const normalized = path.normalize(value)
  if (process.platform === 'win32') {
    return [normalized.replaceAll('\\', '/').toLowerCase()]
  }
  if (process.platform !== 'darwin') {
    return [normalized]
  }
  return normalized.startsWith('/private/var/')
    ? [normalized, normalized.slice('/private'.length)]
    : [normalized, `/private${normalized}`]
}

function pathsMatch(left: string, right: string): boolean {
  return equivalentTestPaths(left).some((candidate) => areWorktreePathsEqual(candidate, right))
}

function waitForCatalogWorktree(page: Page, repoId: string, worktreePath: string): Promise<string> {
  return page.evaluate(
    ({ expectedPaths, expectedRepoId, windows }) => {
      const comparablePath = (value: string): string =>
        windows ? value.replaceAll('\\', '/').toLowerCase() : value
      const findId = (): string | undefined =>
        window.__store
          ?.getState()
          .allWorktrees()
          .find(
            (worktree) =>
              worktree.repoId === expectedRepoId &&
              expectedPaths.includes(comparablePath(worktree.path))
          )?.id
      const existing = findId()
      if (existing) {
        return existing
      }
      return new Promise<string>((resolve) => {
        const unsubscribe = window.__store!.subscribe(() => {
          const id = findId()
          if (id) {
            unsubscribe()
            resolve(id)
          }
        })
      })
    },
    {
      expectedPaths: equivalentTestPaths(worktreePath),
      expectedRepoId: repoId,
      windows: process.platform === 'win32'
    }
  )
}

async function readRuntimeTransportContinuity(page: Page, environmentId: string) {
  const remoteControl = await page.evaluate(async (selector) => {
    const response = await window.api.runtimeEnvironments.getStatus({ selector })
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    return response.result.remoteControl ?? null
  }, environmentId)
  if (!remoteControl || remoteControl.state !== 'ready' || remoteControl.lastConnectedAt === null) {
    throw new Error('Paired client shared-control transport is not ready')
  }
  return {
    state: remoteControl.state,
    lastConnectedAt: remoteControl.lastConnectedAt,
    lastClose: remoteControl.lastClose,
    lastError: remoteControl.lastError,
    reconnectAttempt: remoteControl.reconnectAttempt
  }
}

test('shows an externally created worktree on a paired client without reconnect', async ({
  registerPostElectronShutdownCleanup,
  sharedPage,
  testRepoPath
}, testInfo) => {
  test.setTimeout(120_000)
  const suffix = `${Date.now()}-${testInfo.workerIndex}`
  const branch = `e2e-paired-external-${suffix}`
  const externalPath = path.join(path.dirname(testRepoPath), branch)
  let client: PairedElectronClient | undefined
  let worktreeCreated = false
  registerPostElectronShutdownCleanup(async () => {
    if (worktreeCreated) {
      await gitExecFileAsync(['worktree', 'remove', '--force', externalPath], {
        cwd: testRepoPath
      }).catch(() => undefined)
      await gitExecFileAsync(['branch', '-D', branch], { cwd: testRepoPath }).catch(() => undefined)
    }
    rmSync(externalPath, { recursive: true, force: true })
  })

  try {
    const repos = await sharedPage.evaluate(
      () => window.__store?.getState().repos.map((repo) => ({ id: repo.id, path: repo.path })) ?? []
    )
    const repoId = repos.find((repo) => pathsMatch(repo.path, testRepoPath))?.id
    if (!repoId) {
      throw new Error(`Headed host did not catalog ${testRepoPath}`)
    }
    client = await launchPairedElectronClient(
      await createRuntimeDesktopPairingOffer(sharedPage),
      testInfo,
      'External worktree discovery'
    )
    await client.page.waitForFunction(
      ({ expectedPaths, expectedRepoId, windows }) =>
        window.__store
          ?.getState()
          .allWorktrees()
          .some(
            (worktree) =>
              worktree.repoId === expectedRepoId &&
              expectedPaths.includes(
                windows ? worktree.path.replaceAll('\\', '/').toLowerCase() : worktree.path
              )
          ) ?? false,
      {
        expectedPaths: equivalentTestPaths(testRepoPath),
        expectedRepoId: repoId,
        windows: process.platform === 'win32'
      }
    )

    const clientTransportBefore = await readRuntimeTransportContinuity(
      client.page,
      client.environmentId
    )
    const hostCatalogUpdate = waitForCatalogWorktree(sharedPage, repoId, externalPath)
    const clientCatalogUpdate = waitForCatalogWorktree(client.page, repoId, externalPath)
    await gitExecFileAsync(['worktree', 'add', '--quiet', '-b', branch, externalPath], {
      cwd: testRepoPath
    })
    worktreeCreated = true

    expect(
      (await listWorktreesStrict(testRepoPath)).some((worktree) =>
        pathsMatch(worktree.path, externalPath)
      )
    ).toBe(true)
    const [hostWorktreeId, clientWorktreeId] = await Promise.all([
      hostCatalogUpdate,
      clientCatalogUpdate
    ])
    expect(clientWorktreeId).toBe(hostWorktreeId)
    await expect(worktreeRow(sharedPage, hostWorktreeId)).toBeVisible()
    await expect(worktreeRow(client.page, clientWorktreeId)).toBeVisible()
    expect(await readRuntimeTransportContinuity(client.page, client.environmentId)).toEqual(
      clientTransportBefore
    )
  } finally {
    await client?.dispose()
  }
})
