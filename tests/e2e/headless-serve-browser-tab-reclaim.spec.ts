import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, test } from './helpers/orca-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'

// Why (STA-4341): every agent-created browser tab on a headless `orca serve`
// host is backed by its own hidden BrowserWindow, i.e. its own renderer
// process. Before the reclaimer nothing owned them: six tabs meant six
// renderers that survived any amount of idleness, and an animated page kept
// painting at ~96fps in a window no one could ever see. These specs drive the
// exact RPCs `orca tab …` sends against a real serve process and count the
// renderers the host actually holds.

// Why: an animated canvas is the workload the report measured — it keeps a
// hidden renderer busy, so a leaked renderer costs CPU as well as memory.
const ANIMATED_PAGE = `<!doctype html><meta charset="utf-8"><title>anim</title>
<canvas id="c" width="64" height="64"></canvas>
<script>
  window.__frames = 0
  const ctx = document.getElementById('c').getContext('2d')
  function tick() {
    window.__frames++
    ctx.fillStyle = 'hsl(' + (window.__frames % 360) + ',80%,50%)'
    ctx.fillRect(0, 0, 64, 64)
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
</script>`

// Why: minutes-long production windows would make this spec unrunnable in CI;
// the reclaim policy reads them from the environment so the behaviour under
// test is the shipping one, only faster.
const FAST_RECLAIM_ENV = {
  ORCA_HEADLESS_BROWSER_PARK_IDLE_MS: '1500',
  ORCA_HEADLESS_BROWSER_PARK_GRACE_MS: '400',
  ORCA_HEADLESS_BROWSER_RESIDENT_LIMIT: '2'
}

type HeadlessHost = Awaited<ReturnType<typeof launchHeadlessPairedRuntimeHost>>
type BrowserTab = { browserPageId: string; url: string; parked?: boolean }

async function countOffscreenRenderers(host: HeadlessHost): Promise<number> {
  return host.app.evaluate(
    ({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed()).length
  )
}

async function resolveSeededWorktreeId(host: HeadlessHost, testRepoPath: string): Promise<string> {
  const added = await host.client.call<{ repo: { id: string } }>('repo.add', {
    path: testRepoPath,
    kind: 'git'
  })
  let worktreeId = ''
  await expect
    .poll(
      async () => {
        const listed = await host.client.call<{ worktrees: { id: string }[] }>('worktree.list', {
          repo: `id:${added.result.repo.id}`
        })
        worktreeId = listed.result.worktrees[0]?.id ?? ''
        return worktreeId
      },
      { timeout: 30_000 }
    )
    .not.toBe('')
  return worktreeId
}

async function startAnimatedPageServer(): Promise<{
  url: string
  close: () => void
}> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(ANIMATED_PAGE)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
    close: () => server.close()
  }
}

async function createTabs(
  host: HeadlessHost,
  worktreeId: string,
  url: string,
  count: number
): Promise<string[]> {
  const pageIds: string[] = []
  for (let index = 0; index < count; index++) {
    const created = await host.client.call<{ browserPageId: string }>(
      'browser.tabCreate',
      { url, worktree: `id:${worktreeId}` },
      { timeoutMs: 60_000 }
    )
    pageIds.push(created.result.browserPageId)
  }
  return pageIds
}

async function listTabs(host: HeadlessHost, worktreeId: string): Promise<BrowserTab[]> {
  const listed = await host.client.call<{ tabs: BrowserTab[] }>('browser.tabList', {
    worktree: `id:${worktreeId}`
  })
  return listed.result.tabs
}

test('reclaims idle agent browser tab renderers without losing the tabs', async ({
  testRepoPath
}) => {
  test.setTimeout(240_000)
  const host = await launchHeadlessPairedRuntimeHost({
    extraEnv: FAST_RECLAIM_ENV
  })
  const pageServer = await startAnimatedPageServer()
  try {
    const worktreeId = await resolveSeededWorktreeId(host, testRepoPath)
    expect(await countOffscreenRenderers(host)).toBe(0)

    const pageIds = await createTabs(host, worktreeId, pageServer.url, 6)
    expect(await countOffscreenRenderers(host)).toBe(6)

    // Nothing targets these pages and no client streams them, so every
    // renderer must be reclaimed once the idle window elapses.
    await expect.poll(() => countOffscreenRenderers(host), { timeout: 30_000 }).toBe(0)

    // The pages themselves survive: an agent holding a page id still sees its
    // tab, marked parked, at the address it left it on.
    const tabs = await listTabs(host, worktreeId)
    expect(tabs.map((tab) => tab.browserPageId).sort()).toEqual([...pageIds].sort())
    expect(tabs.every((tab) => tab.parked === true)).toBe(true)
    expect(tabs.every((tab) => tab.url === pageServer.url)).toBe(true)
  } finally {
    pageServer.close()
    await host.dispose()
  }
})

test('wakes a parked browser tab on the next command that targets it', async ({ testRepoPath }) => {
  test.setTimeout(240_000)
  const host = await launchHeadlessPairedRuntimeHost({
    extraEnv: FAST_RECLAIM_ENV
  })
  const pageServer = await startAnimatedPageServer()
  try {
    const worktreeId = await resolveSeededWorktreeId(host, testRepoPath)
    const [pageId] = await createTabs(host, worktreeId, pageServer.url, 1)
    await expect.poll(() => countOffscreenRenderers(host), { timeout: 30_000 }).toBe(0)

    const evaluated = await host.client.call<{
      result: string
      origin: string
    }>('browser.eval', { expression: 'document.title', page: pageId }, { timeoutMs: 60_000 })
    expect(evaluated.result.result).toBe('anim')
    expect(evaluated.result.origin).toBe(pageServer.url)
    expect(await countOffscreenRenderers(host)).toBe(1)

    const tabs = await listTabs(host, worktreeId)
    expect(tabs).toHaveLength(1)
    expect(tabs[0].parked).toBeFalsy()

    // A woken page must still be closable, and closing it must free the renderer.
    const closed = await host.client.call<{ closed: boolean }>('browser.tabClose', { page: pageId })
    expect(closed.result.closed).toBe(true)
    await expect.poll(() => countOffscreenRenderers(host), { timeout: 15_000 }).toBe(0)
    expect(await listTabs(host, worktreeId)).toHaveLength(0)
  } finally {
    pageServer.close()
    await host.dispose()
  }
})

test('bounds resident renderers by the cap while tabs are still in use', async ({
  testRepoPath
}) => {
  test.setTimeout(240_000)
  const host = await launchHeadlessPairedRuntimeHost({
    // Why: a long idle window isolates the cap as the evictor — nothing here
    // parks because of the clock.
    extraEnv: {
      ...FAST_RECLAIM_ENV,
      ORCA_HEADLESS_BROWSER_PARK_IDLE_MS: '600000'
    }
  })
  const pageServer = await startAnimatedPageServer()
  try {
    const worktreeId = await resolveSeededWorktreeId(host, testRepoPath)
    const pageIds = await createTabs(host, worktreeId, pageServer.url, 5)

    // Why keep driving them: a page's reclaim clock also restarts when its load
    // finally completes, and load completion does not have to follow creation
    // order — so a single touch up front can be overtaken by a page that
    // finished loading later. Two pages that stay in use are unambiguously the
    // most recently used, which is exactly the case this test is about.
    const inUsePageIds = [pageIds[0], pageIds[3]]
    const useThenCountRenderers = async (): Promise<number> => {
      for (const pageId of inUsePageIds) {
        await host.client
          .call(
            'browser.eval',
            { expression: 'document.title', page: pageId },
            { timeoutMs: 60_000 }
          )
          .catch(() => {})
      }
      return countOffscreenRenderers(host)
    }

    await expect.poll(useThenCountRenderers, { timeout: 30_000 }).toBe(2)

    // Every page is still open; only the two in use kept a renderer.
    const tabs = await listTabs(host, worktreeId)
    expect(tabs).toHaveLength(5)
    const residentIds = tabs.filter((tab) => !tab.parked).map((tab) => tab.browserPageId)
    expect(residentIds.sort()).toEqual([...inUsePageIds].sort())
  } finally {
    pageServer.close()
    await host.dispose()
  }
})

test('resolves --index against the listing that includes parked tabs', async ({ testRepoPath }) => {
  test.setTimeout(240_000)
  const host = await launchHeadlessPairedRuntimeHost({
    // Why: a tight cap with no idle clock leaves a mixed listing — some tabs
    // resident, some parked — which is where an index can address the wrong tab.
    extraEnv: {
      ...FAST_RECLAIM_ENV,
      ORCA_HEADLESS_BROWSER_PARK_IDLE_MS: '600000'
    }
  })
  const pageServer = await startAnimatedPageServer()
  try {
    const worktreeId = await resolveSeededWorktreeId(host, testRepoPath)
    const pageIds = await createTabs(host, worktreeId, pageServer.url, 5)
    await expect.poll(() => countOffscreenRenderers(host), { timeout: 30_000 }).toBe(2)

    const before = await listTabs(host, worktreeId)
    // Why: the listing is creation-ordered end to end — parking must not move
    // a tab's position, or the index a caller read goes stale on a timer.
    expect(before.map((tab) => tab.browserPageId)).toEqual(pageIds)
    // Why: the listing is creation-ordered, so parked and resident tabs are
    // interleaved. Target a parked one — an index the bridge's live-only index
    // handling would either miss or resolve to a different (live) tab.
    const targetIndex = before.findIndex((tab) => tab.parked === true)
    expect(targetIndex).toBeGreaterThanOrEqual(0)
    const targeted = before[targetIndex]

    await host.client.call('browser.tabClose', {
      index: targetIndex,
      worktree: `id:${worktreeId}`
    })

    const after = await listTabs(host, worktreeId)
    expect(after.map((tab) => tab.browserPageId)).not.toContain(targeted.browserPageId)
    expect(after).toHaveLength(4)
  } finally {
    pageServer.close()
    await host.dispose()
  }
})

test('keeps a parked tab closable without waking its renderer', async ({ testRepoPath }) => {
  test.setTimeout(240_000)
  const host = await launchHeadlessPairedRuntimeHost({
    extraEnv: FAST_RECLAIM_ENV
  })
  const pageServer = await startAnimatedPageServer()
  try {
    const worktreeId = await resolveSeededWorktreeId(host, testRepoPath)
    const pageIds = await createTabs(host, worktreeId, pageServer.url, 2)
    await expect.poll(() => countOffscreenRenderers(host), { timeout: 30_000 }).toBe(0)

    const closed = await host.client.call<{ closed: boolean }>('browser.tabClose', {
      page: pageIds[0]
    })
    expect(closed.result.closed).toBe(true)
    expect(await countOffscreenRenderers(host)).toBe(0)

    const tabs = await listTabs(host, worktreeId)
    expect(tabs.map((tab) => tab.browserPageId)).toEqual([pageIds[1]])
  } finally {
    pageServer.close()
    await host.dispose()
  }
})
