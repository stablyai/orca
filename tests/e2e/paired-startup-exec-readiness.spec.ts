import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedWebClient
} from './helpers/paired-electron-client'
import {
  callStartupExecRuntime,
  closeStartupExecTerminal,
  createStartupExecTerminal,
  expectStartupExecRecovery,
  installZshExecProfile
} from './helpers/startup-exec-readiness-oracle'

test.skip(process.platform === 'win32', 'Paired startup-exec readiness uses POSIX shells.')

async function waitForWorktree(page: Page, id: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          (worktreeId) =>
            window.__store
              ?.getState()
              .allWorktrees()
              .some((candidate) => candidate.id === worktreeId),
          id
        ),
      { timeout: 30_000 }
    )
    .toBe(true)
  await expect
    .poll(
      async () => {
        const listed = await callStartupExecRuntime<{ worktrees: { id: string }[] }>(
          page,
          'worktree.list',
          {}
        )
        return listed.worktrees.some((candidate) => candidate.id === id)
      },
      { timeout: 30_000 }
    )
    .toBe(true)
}

function expectLedger(ledgerPath: string): void {
  const [pid, tty] = readFileSync(ledgerPath, 'utf8').trim().split('|')
  expect(Number(pid)).toBeGreaterThan(1)
  expect(tty).toMatch(/^\/dev\//)
}

async function releaseExecBarrier(
  startedPath: string,
  releasePath: string,
  ledgerPath: string
): Promise<void> {
  await expect
    .poll(
      () =>
        existsSync(startedPath)
          ? 'started'
          : existsSync(ledgerPath)
            ? readFileSync(ledgerPath, 'utf8').trim()
            : 'pending',
      { timeout: 30_000 }
    )
    .toBe('started')
  expect(existsSync(ledgerPath)).toBe(false)
  writeFileSync(releasePath, '')
}

function cleanupExecBarrier(startedPath: string, releasePath: string): void {
  rmSync(startedPath, { force: true })
  rmSync(releasePath, { force: true })
}

test('recovers startup exec through a headed paired desktop owner @headful', async ({
  electronApp,
  orcaPage
}) => {
  test.setTimeout(90_000)
  const runId = `headed_${Date.now()}`
  const homePath = await electronApp.evaluate(({ app }) => app.getPath('home'))
  const ledgerPath = path.join(homePath, `.sta4067-${runId}.ledger`)
  const startedPath = path.join(homePath, `.sta4067-${runId}.started`)
  const releasePath = path.join(homePath, `.sta4067-${runId}.release`)
  const removeProfile = installZshExecProfile(homePath, runId, { releasePath, startedPath })
  const worktreeId = await orcaPage.evaluate(() => window.__store?.getState().activeWorktreeId)
  if (!worktreeId) {
    throw new Error('Headed owner has no active worktree')
  }
  const offer = await createRuntimeDesktopPairingOffer(orcaPage)
  const client = await launchPairedWebClient(electronApp, offer)
  let terminal: string | null = null
  try {
    await waitForWorktree(client.page, worktreeId)
    const created = await createStartupExecTerminal(
      client.page,
      worktreeId,
      runId,
      ledgerPath,
      'paired-client',
      '/bin/zsh',
      { ORCA_ORIG_ZDOTDIR: homePath, ORCA_ZSHENV_SOURCE_DIR: homePath }
    )
    terminal = created.terminal
    await releaseExecBarrier(startedPath, releasePath, ledgerPath)
    await expectStartupExecRecovery(client.page, created, runId)
    expectLedger(ledgerPath)
  } finally {
    await closeStartupExecTerminal(orcaPage, terminal)
    await client.dispose()
    removeProfile()
    cleanupExecBarrier(startedPath, releasePath)
  }
})

test('recovers the same startup exec through an isolated headless orca serve', async ({
  testRepoPath
}) => {
  test.setTimeout(120_000)
  const runId = `headless_${Date.now()}`
  const host = await launchHeadlessPairedRuntimeHost()
  let terminal: string | null = null
  let removeProfile: (() => void) | undefined
  let client: Awaited<ReturnType<typeof launchPairedWebClient>> | undefined
  let startedPath = ''
  let releasePath = ''
  try {
    const homePath = await host.app.evaluate(({ app }) => app.getPath('home'))
    const ledgerPath = path.join(homePath, `.sta4067-${runId}.ledger`)
    startedPath = path.join(homePath, `.sta4067-${runId}.started`)
    releasePath = path.join(homePath, `.sta4067-${runId}.release`)
    removeProfile = installZshExecProfile(homePath, runId, { releasePath, startedPath })
    client = await launchPairedWebClient(host.app, host.offer, { waitForWorkspace: false })
    await host.client.call('repo.add', { path: testRepoPath, kind: 'git' })
    await client.page.locator('[data-worktree-sidebar]').waitFor({
      state: 'visible',
      timeout: 30_000
    })
    await expect
      .poll(
        () => client.page.evaluate(() => window.__store?.getState().allWorktrees()[0]?.id ?? null),
        { timeout: 30_000 }
      )
      .not.toBeNull()
    const worktreeId = await client.page.evaluate(
      () => window.__store?.getState().allWorktrees()[0]?.id ?? null
    )
    if (!worktreeId) {
      throw new Error('Headless owner did not publish its worktree')
    }
    const created = await createStartupExecTerminal(
      client.page,
      worktreeId,
      runId,
      ledgerPath,
      'paired-client',
      '/bin/zsh',
      { ORCA_ORIG_ZDOTDIR: homePath, ORCA_ZSHENV_SOURCE_DIR: homePath }
    )
    terminal = created.terminal
    await releaseExecBarrier(startedPath, releasePath, ledgerPath)
    await expectStartupExecRecovery(client.page, created, runId)
    expectLedger(ledgerPath)
  } finally {
    try {
      if (client) {
        await closeStartupExecTerminal(client.page, terminal)
        await client.dispose()
      }
      removeProfile?.()
      if (startedPath) {
        cleanupExecBarrier(startedPath, releasePath)
      }
    } finally {
      await host.dispose()
    }
  }
})
