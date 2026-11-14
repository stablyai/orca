/**
 * #38653: a panel's `workspace.readContext` names the focused workspace when it lives on a paired
 * Orca server, and a focused local workspace's context is unchanged by that remote fallback.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Locator, Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import { launchPairedElectronClient } from './helpers/paired-electron-client'
import { enableDevPlugins } from './helpers/plugin-smoke'
import { pluginGuest, readInGuest, waitForGuestReady } from './helpers/plugin-frame-guest'
import { worktreeRowSurface } from './worktree-row-locators'

// What a plugin sees: labels and terminals, never the raw id or path.
type Context = { branch: string; displayName: string; terminals: { id: string }[] } | null

const SERVER_LABEL = 'Server checkout'

const PANEL = `<!doctype html><html><body><script>
window.__ask = () => {
  const started = performance.now()
  return orca.host.call('workspace.readContext').then((value) => {
    window.__answer = { value, ms: performance.now() - started }
  }, (error) => {
    window.__answer = { value: null, ms: performance.now() - started, error: String(error) }
  })
}
</script></body></html>`

async function readContext(
  guest: Locator
): Promise<{ value: Context; ms: number; error?: string }> {
  await readInGuest(guest, 'window.__answer = null')
  await readInGuest(guest, 'window.__ask()')
  let answer: { value: Context; ms: number; error?: string } | null = null
  await expect
    .poll(async () => (answer = await readInGuest(guest, 'window.__answer ?? null')), {
      timeout: 15_000
    })
    .not.toBeNull()
  if (answer!.error) {
    throw new Error(`workspace.readContext failed: ${answer!.error}`)
  }
  return answer!
}

function focus(page: Page) {
  return page.evaluate(() => {
    const state = window.__store!.getState()
    return {
      activeWorktreeId: state.activeWorktreeId,
      activeWorkspaceKey: state.activeWorkspaceKey,
      activeWorkspaceExecutionHostId: state.activeWorkspaceExecutionHostId
    }
  })
}

test('a panel reads the focused paired-server workspace, and a local one as before', async ({
  testRepoPath
}, testInfo) => {
  // Two Electron launches (server and paired desktop), a sync, and ~16 s of offline panel polling.
  test.setTimeout(300_000)
  const host = await launchHeadlessPairedRuntimeHost()
  let hostRunning = true
  const tempRoot = await mkdtemp(join(tmpdir(), 'orca-38653-'))
  const pluginRoot = join(tempRoot, 'context-probe')
  try {
    const added = await host.client.call<{ repo: { id: string } }>('repo.add', {
      path: testRepoPath,
      kind: 'git'
    })
    const serverRepoId = added.result.repo.id
    const desktop = await launchPairedElectronClient(host.offer, testInfo, 'context host', {
      extraEnv: { ORCA_PLUGIN_ISOLATED_FRAMES: '1' }
    })
    try {
      const page = desktop.page
      const hostId = `runtime:${desktop.environmentId}`
      // The desktop's own checkout of the same repo, beside the server's rows.
      const localId = await page.evaluate(async (repoPath) => {
        const store = window.__store!
        await store.getState().setActiveRuntimeEnvironmentPreference(null)
        const repo = await window.api.repos.add({ path: repoPath, displayName: 'Desktop copy' })
        if ('error' in repo) {
          throw new Error(repo.error)
        }
        await store.getState().fetchReposForAllHosts()
        await store.getState().fetchWorktrees(repo.repo.id, { forceLocalOwner: true })
        store.getState().setVisibleWorkspaceHostIds(null)
        const worktree = store
          .getState()
          .worktreesByRepo[repo.repo.id]?.find((row) => row.isMainWorktree)
        if (!worktree) {
          throw new Error('Local checkout missing')
        }
        return worktree.id
      }, testRepoPath)
      const findServerId = (): Promise<string | null> =>
        page.evaluate(
          ({ repoId, hostId }) =>
            window.__store
              ?.getState()
              .allWorktrees()
              .find((worktree) => worktree.repoId === repoId && worktree.hostId === hostId)?.id ??
            null,
          { repoId: serverRepoId, hostId }
        )
      await expect
        .poll(findServerId, {
          timeout: 60_000,
          message: "The desktop never listed the server's row"
        })
        .not.toBeNull()
      const serverId = (await findServerId())!
      expect(serverId).not.toBe(localId)
      // A label only the server's copy carries, so the panel's answer names which one it read.
      await host.client.call('worktree.set', {
        worktree: `id:${serverId}`,
        displayName: SERVER_LABEL
      })

      await mkdir(pluginRoot, { recursive: true })
      await writeFile(join(pluginRoot, 'panel.html'), PANEL)
      await writeFile(
        join(pluginRoot, 'orca-plugin.json'),
        JSON.stringify({
          manifestVersion: 2,
          execution: 'sandboxed-ui',
          id: 'context-probe',
          name: 'Context Probe',
          version: '1.0.0',
          engines: { orca: '>=1.4.246' },
          pluginApi: 1,
          contributes: { panels: [{ id: 'probe', title: 'Context Probe', entry: 'panel.html' }] },
          capabilities: [{ kind: 'workspace:read' }]
        })
      )
      await enableDevPlugins(page, [pluginRoot])
      await page.evaluate(async () => {
        const store = window.__store?.getState()
        if (store && !store.rightSidebarOpen) {
          store.toggleRightSidebar()
        }
        await window.api.plugins.refresh()
      })

      // Local focus through the real sidebar click.
      await worktreeRowSurface(page, localId).click()
      await expect
        .poll(() => focus(page))
        .toEqual({
          activeWorktreeId: localId,
          activeWorkspaceKey: `worktree:${localId}`,
          activeWorkspaceExecutionHostId: 'local'
        })
      await page.getByRole('button', { name: 'Context Probe' }).click({ timeout: 15_000 })
      const guest = pluginGuest(page, 'Context Probe')
      await waitForGuestReady(guest)
      let local: Context = null
      await expect
        .poll(async () => (local = (await readContext(guest)).value)?.terminals.length ?? 0, {
          timeout: 30_000
        })
        .toBeGreaterThan(0)
      expect(local!.branch).not.toBe('')
      expect(local!.displayName).not.toBe(SERVER_LABEL)

      // The server's workspace, same path on another host, through the same click.
      await worktreeRowSurface(page, serverId).click()
      await expect
        .poll(() => focus(page))
        .toEqual({
          activeWorktreeId: serverId,
          activeWorkspaceKey: `worktree:${serverId}`,
          activeWorkspaceExecutionHostId: hostId
        })
      let remote: Context = null
      await expect
        .poll(async () => (remote = (await readContext(guest)).value)?.displayName ?? null, {
          timeout: 30_000,
          message: 'readContext never named the focused server workspace'
        })
        .toBe(SERVER_LABEL)
      expect(remote!.branch).toBe(local!.branch)
      // The server's terminals, never the desktop checkout's.
      const localTerminalIds = new Set(local!.terminals.map(({ id }) => id))
      expect(remote!.terminals.filter(({ id }) => localTerminalIds.has(id))).toEqual([])
      // Panel polling must stay off the 1.5 s fetch bound once the desktop holds the server's rows.
      const polls: number[] = []
      for (let poll = 0; poll < 5; poll += 1) {
        const answer = await readContext(guest)
        expect(answer.value?.displayName).toBe(SERVER_LABEL)
        polls.push(answer.ms)
      }
      testInfo.annotations.push({ type: 'remote readContext ms', description: polls.join(',') })
      expect(Math.max(...polls)).toBeLessThan(1_000)

      // The server goes away: polls keep answering promptly, from the rows the desktop holds.
      await host.dispose()
      hostRunning = false
      const offline: number[] = []
      // ast-grep-ignore: test-no-polling-loop -- replays a panel's 2 s poll to time each answer; nothing is awaited
      for (let poll = 0; poll < 8; poll += 1) {
        const answer = await readContext(guest)
        expect(answer.value?.displayName).toBe(SERVER_LABEL)
        offline.push(answer.ms)
        // ast-grep-ignore: test-no-real-time-wait -- the claim spans the real 10 s refetch window of a panel's 2 s poll
        await page.waitForTimeout(2_000)
      }
      testInfo.annotations.push({ type: 'offline readContext ms', description: offline.join(',') })
      // At most the 1.5 s fetch bound, and never on consecutive polls.
      expect(Math.max(...offline)).toBeLessThan(1_800)
      expect(offline.filter((ms) => ms > 1_000).length).toBeLessThanOrEqual(2)

      // Back to the local checkout: the same context as before the remote focus.
      await worktreeRowSurface(page, localId).click()
      await expect
        .poll(async () => (await readContext(guest)).value, { timeout: 30_000 })
        .toEqual(local)
    } finally {
      await desktop.dispose()
    }
  } finally {
    if (hostRunning) {
      await host.dispose()
    }
    await rm(tempRoot, { recursive: true, force: true })
  }
})
