/**
 * A desktop paired to an `orca serve` host raises a workspace's unread flag itself exactly when that
 * host does not: an older host (played by withholding its capability) gets the window's flag, and a
 * current host is left to raise its own.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { Page, TestInfo } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import {
  launchHeadlessPairedRuntimeHost,
  type HeadlessPairedRuntimeHost
} from './helpers/headless-paired-runtime-host'
import { launchPairedElectronClient } from './helpers/paired-electron-client'
import { SIDEBAR_INPUTS_BUILD } from './helpers/sidebar-inputs-build'

test.skip(
  !SIDEBAR_INPUTS_BUILD,
  'the window defers the unread flag to its host only in an ORCA_SIDEBAR_INPUTS=main build'
)

const ReposSchema = z.object({
  repos: z.array(z.looseObject({ id: z.string(), path: z.string() }))
})
const WorktreeSchema = z.object({
  worktree: z.looseObject({ id: z.string(), path: z.string(), isUnread: z.boolean().optional() })
})

async function launchHost(olderHost: boolean): Promise<HeadlessPairedRuntimeHost> {
  // The serve process copies this env at launch; the desktop launched after must not see it.
  if (olderHost) {
    process.env.ORCA_E2E_OLDER_UNREAD_HOST = '1'
  }
  try {
    return await launchHeadlessPairedRuntimeHost({ pairingScope: 'runtime' })
  } finally {
    delete process.env.ORCA_E2E_OLDER_UNREAD_HOST
  }
}

async function createServerWorktree(
  host: HeadlessPairedRuntimeHost,
  testInfo: TestInfo
): Promise<string> {
  const serverRepo = testInfo.outputPath('server-repo')
  mkdirSync(serverRepo, { recursive: true })
  writeFileSync(path.join(serverRepo, 'README.md'), 'server repo\n')
  const git = (...args: string[]) => execFileSync('git', args, { cwd: serverRepo, stdio: 'pipe' })
  git('init', '-b', 'main')
  git('add', 'README.md')
  git('-c', 'user.name=E2E', '-c', 'user.email=e2e@test.local', 'commit', '-m', 'init')
  await host.client.call('repo.add', { path: serverRepo, kind: 'git' })
  const { repos } = ReposSchema.parse((await host.client.call('repo.list', {})).result)
  const repo = `id:${repos.find((entry) => entry.path === serverRepo)?.id ?? ''}`
  const created = await host.client.call('worktree.create', {
    repo,
    name: 'flagged',
    setupDecision: 'skip'
  })
  return WorktreeSchema.parse(created.result).worktree.id
}

async function hostFlag(host: HeadlessPairedRuntimeHost, worktreeId: string): Promise<boolean> {
  const shown = await host.client.call('worktree.show', { worktree: `id:${worktreeId}` })
  return WorktreeSchema.parse(shown.result).worktree.isUnread === true
}

/** The window's own decision for a finish it saw while its user was elsewhere. */
async function windowMarksUnread(page: Page, worktreeId: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          (id) =>
            Object.values(window.__store?.getState().worktreesByRepo ?? {})
              .flat()
              .some((worktree) => worktree.id === id),
          worktreeId
        ),
      { timeout: 60_000 }
    )
    .toBe(true)
  await page.evaluate((id) => {
    window.__store?.getState().markAgentAttentionUnread({
      workspaceId: id,
      subjectKey: null,
      groupId: null,
      reason: 'agent-completion'
    })
  }, worktreeId)
}

test('the window raises and clears the flag on an older paired host that raises none', async (// oxlint-disable-next-line no-empty-pattern -- this test owns its topology launch.
{}, testInfo) => {
  test.setTimeout(240_000)
  const host = await launchHost(true)
  try {
    const worktreeId = await createServerWorktree(host, testInfo)
    const desktop = await launchPairedElectronClient(host.offer, testInfo, 'older-host-desktop')
    try {
      await windowMarksUnread(desktop.page, worktreeId)
      await expect.poll(() => hostFlag(host, worktreeId), { timeout: 30_000 }).toBe(true)

      // Mark as read writes through to the older host as well.
      await desktop.page.evaluate((id) => {
        const state = window.__store!.getState()
        const row = Object.values(state.worktreesByRepo)
          .flat()
          .find((worktree) => worktree.id === id)
        if (!row?.hostId) {
          throw new Error('server workspace row has no host')
        }
        state.setWorkspaceUnreadByUser(id, false, row.hostId)
      }, worktreeId)
      await expect.poll(() => hostFlag(host, worktreeId), { timeout: 30_000 }).toBe(false)
    } finally {
      await desktop.dispose()
    }
  } finally {
    await host.dispose()
  }
})

test('the window leaves the flag to a paired host that raises it', async (// oxlint-disable-next-line no-empty-pattern -- this test owns its topology launch.
{}, testInfo) => {
  test.setTimeout(240_000)
  const host = await launchHost(false)
  try {
    const worktreeId = await createServerWorktree(host, testInfo)
    const desktop = await launchPairedElectronClient(host.offer, testInfo, 'current-host-desktop')
    try {
      await windowMarksUnread(desktop.page, worktreeId)
      // Nothing on the host saw news, so its flag stays down and the window wrote none.
      await desktop.page.waitForTimeout(3_000)
      expect(await hostFlag(host, worktreeId)).toBe(false)
    } finally {
      await desktop.dispose()
    }
  } finally {
    await host.dispose()
  }
})
