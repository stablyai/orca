// Without phone requests, desktop main must retain server rows from change events and agree with its window’s catalog.
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { expect, test } from './helpers/orca-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import { launchPairedElectronClient } from './helpers/paired-electron-client'
import { SIDEBAR_INPUTS_BUILD } from './helpers/sidebar-inputs-build'
import type { Page } from '@stablyai/playwright-test'

test.skip(
  !SIDEBAR_INPUTS_BUILD,
  'main publishes sidebar inputs only in an ORCA_SIDEBAR_INPUTS=main build'
)

const SnapshotSchema = z.object({
  servers: z.array(
    z.object({
      hostId: z.string(),
      freshness: z.string(),
      host: z.looseObject({ health: z.string() }).nullable(),
      rows: z.array(
        z.looseObject({
          key: z.string(),
          worktreeId: z.string(),
          path: z.string(),
          isPinned: z.boolean()
        })
      )
    })
  )
})
const ReposSchema = z.object({
  repos: z.array(z.looseObject({ id: z.string(), path: z.string() }))
})
const CreateSchema = z.object({ worktree: z.looseObject({ id: z.string() }) })

async function mainServerRows(page: Page) {
  const response = await page.evaluate(() =>
    window.api.runtime.call({ method: 'sidebarInputs.pairedServerRows' })
  )
  expect(response.ok).toBe(true)
  const server = SnapshotSchema.parse(response.ok ? response.result : null).servers[0]
  return {
    freshness: server?.freshness ?? null,
    health: server?.host?.health ?? null,
    names: (server?.rows ?? []).map((row) => path.basename(row.path)).sort(),
    pinned: (server?.rows ?? [])
      .filter((row) => row.isPinned)
      .map((row) => path.basename(row.path)),
    keys: (server?.rows ?? []).map((row) => row.key)
  }
}

test("main keeps a paired server's rows live, deletions included, and unverifiable while it is down", async (// oxlint-disable-next-line no-empty-pattern -- this test owns its topology launch.
{}, testInfo) => {
  test.setTimeout(240_000)
  const serverRepo = testInfo.outputPath('server-repo')
  mkdirSync(serverRepo, { recursive: true })
  writeFileSync(path.join(serverRepo, 'README.md'), 'server repo\n')
  const git = (...args: string[]) => execFileSync('git', args, { cwd: serverRepo, stdio: 'pipe' })
  git('init', '-b', 'main')
  git('add', 'README.md')
  git('-c', 'user.name=E2E', '-c', 'user.email=e2e@test.local', 'commit', '-m', 'init')

  const host = await launchHeadlessPairedRuntimeHost({
    pairingScope: 'runtime',
    pinnedServePort: true
  })
  try {
    const desktop = await launchPairedElectronClient(host.offer, testInfo, 'server-rows-desktop')
    try {
      await host.client.call('repo.add', { path: serverRepo, kind: 'git' })
      const { repos } = ReposSchema.parse((await host.client.call('repo.list', {})).result)
      const repo = `id:${repos.find((entry) => entry.path === serverRepo)?.id ?? ''}`
      const create = async (name: string): Promise<string> =>
        CreateSchema.parse(
          (await host.client.call('worktree.create', { repo, name, setupDecision: 'skip' })).result
        ).worktree.id
      await create('kept')
      const removed = await create('removed')

      // Created on the server itself: only its change events can tell main.
      await expect
        .poll(async () => (await mainServerRows(desktop.page)).names, { timeout: 60_000 })
        .toEqual(expect.arrayContaining(['kept', 'removed']))
      expect(
        (await mainServerRows(desktop.page)).keys.every((key) => key.startsWith('runtime:'))
      ).toBe(true)
      expect((await mainServerRows(desktop.page)).health).toBe('available')

      await host.client.call('worktree.set', { worktree: `id:${removed}`, isPinned: true })
      await expect
        .poll(async () => (await mainServerRows(desktop.page)).pinned, { timeout: 30_000 })
        .toEqual(['removed'])
      await host.client.call('worktree.rm', {
        worktree: `id:${removed}`,
        force: true,
        runHooks: false
      })
      await expect
        .poll(async () => (await mainServerRows(desktop.page)).names, { timeout: 30_000 })
        .not.toContain('removed')

      // A server that stops answering keeps its last rows, never read as gone.
      await host.restartServeProcess({
        betweenProcesses: async () => {
          await expect
            .poll(async () => (await mainServerRows(desktop.page)).freshness, { timeout: 60_000 })
            .toBe('unverifiable')
          expect((await mainServerRows(desktop.page)).names).toContain('kept')
        }
      })
      await expect
        .poll(async () => (await mainServerRows(desktop.page)).freshness, { timeout: 90_000 })
        .toBe('live')
      expect((await mainServerRows(desktop.page)).names).toContain('kept')
    } finally {
      await desktop.dispose()
    }
  } finally {
    await host.dispose()
  }
})
