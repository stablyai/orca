// Keep two paired desktop mirrors aligned with one desktop host across create, partial close, emptying and reseed.
// Empty tombstones are client-local; Phase 0 proves create propagation, Phase 1a separates general close retractions from empty-workspace handling.
// Earlier runs lost all close retractions on both clients for 90s while creates still propagated; host retirement publication fixed that shape.
// Treat recurrence as a publish-after-close regression, not an exclusion.
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

/** How long a client may lag the host before the user would call it broken. */
const MIRROR_BUDGET_MS = 30_000
/** A retraction may be slow; what matters is whether it arrives at all. */
const RETRACTION_BUDGET_MS = 90_000

type HostTabRow = { id: string; parentTabId?: string; terminal?: string | null }

async function callEnvironment<TResult>(
  page: Page,
  environmentId: string,
  method: string,
  params: unknown
): Promise<TResult> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: page.evaluate is typed unknown across the bridge; TResult is the caller's declared RPC result.
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

/** The host's own tab inventory — the only oracle that is not a client re-derivation. */
async function readHostTerminalTabIds(
  client: PairedElectronClient,
  worktreeId: string
): Promise<string[]> {
  const inventory = await callEnvironment<{ tabs: HostTabRow[] }>(
    client.page,
    client.environmentId,
    'session.tabs.list',
    { worktree: `id:${worktreeId}` }
  )
  return [
    ...new Set(
      inventory.tabs
        .filter((tab) => tab.terminal !== undefined && tab.terminal !== null)
        .map((tab) => tab.parentTabId ?? tab.id)
    )
  ].sort()
}

async function readMirroredTabCount(page: Page, worktreeId: string): Promise<number> {
  return page.evaluate(
    (id) => (window.__store?.getState().tabsByWorktree[id] ?? []).length,
    worktreeId
  )
}

/** Whether the client holds an explicit empty row (the tombstone) versus no row at all. */
async function readWorkspaceRowState(
  page: Page,
  worktreeId: string
): Promise<'missing' | 'tombstoned' | 'populated'> {
  return page.evaluate((id) => {
    const tabs = window.__store?.getState().tabsByWorktree
    if (!tabs || !Object.hasOwn(tabs, id)) {
      return 'missing' as const
    }
    return (tabs[id] ?? []).length === 0 ? ('tombstoned' as const) : ('populated' as const)
  }, worktreeId)
}

async function focusWorkspace(page: Page, worktreeId: string): Promise<void> {
  await page.evaluate((id) => {
    const state = window.__store?.getState()
    state?.setActiveView('terminal')
    state?.setActiveWorktree(id)
  }, worktreeId)
}

/** Milliseconds until the client's mirrored count matches the host's, or null if it never did. */
async function waitForClientToMatchHost(
  client: PairedElectronClient,
  hostCount: number,
  worktreeId: string,
  budgetMs: number
): Promise<number | null> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < budgetMs) {
    if ((await readMirroredTabCount(client.page, worktreeId)) === hostCount) {
      return Date.now() - startedAt
    }
    await client.page.waitForTimeout(500)
  }
  return null
}

async function waitForClientWorkspace(page: Page, worktreeId: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          (id) => (window.__store?.getState().allWorktrees() ?? []).some((w) => w.id === id),
          worktreeId
        ),
      { timeout: 60_000, message: 'paired client never received the host workspace' }
    )
    .toBe(true)
}

test('two paired clients stay in step with the host across an emptied workspace', async ({
  orcaPage
}, testInfo) => {
  test.setTimeout(600_000)
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  const worktreeId = await orcaPage.evaluate(() => {
    const id = window.__store?.getState().activeWorktreeId
    if (!id) {
      throw new Error('host has no active worktree')
    }
    return id
  })

  let clientA: PairedElectronClient | null = null
  let clientB: PairedElectronClient | null = null
  const failures: string[] = []
  try {
    clientA = await launchPairedElectronClient(
      await createRuntimeDesktopPairingOffer(orcaPage),
      testInfo,
      'emptied-workspace-client-a'
    )
    clientB = await launchPairedElectronClient(
      await createRuntimeDesktopPairingOffer(orcaPage),
      testInfo,
      'emptied-workspace-client-b'
    )
    for (const client of [clientA, clientB]) {
      await waitForClientWorkspace(client.page, worktreeId)
      await focusWorkspace(client.page, worktreeId)
    }

    await callEnvironment(clientA.page, clientA.environmentId, 'session.tabs.createTerminal', {
      worktree: `id:${worktreeId}`,
      activate: true,
      select: true,
      navigation: 'caller'
    })
    const afterCreate = (await readHostTerminalTabIds(clientA, worktreeId)).length
    const controlA = await waitForClientToMatchHost(
      clientA,
      afterCreate,
      worktreeId,
      MIRROR_BUDGET_MS
    )
    const controlB = await waitForClientToMatchHost(
      clientB,
      afterCreate,
      worktreeId,
      MIRROR_BUDGET_MS
    )
    console.error(`[two-client] phase0 host=${afterCreate} A=${controlA}ms B=${controlB}ms`)
    if (controlA === null || controlB === null) {
      failures.push(
        `phase0: a terminal created on one client never reached the other (host=${afterCreate}, A=${controlA}, B=${controlB})`
      )
    }

    // Close while other terminals remain, separating general retraction failure from empty-workspace handling.
    const beforePartialClose = await readHostTerminalTabIds(clientA, worktreeId)
    if (beforePartialClose.length > 1) {
      await callEnvironment(clientA.page, clientA.environmentId, 'session.tabs.close', {
        worktree: `id:${worktreeId}`,
        tabId: beforePartialClose[0]!,
        reason: 'user',
        navigation: 'caller'
      })
      const remaining = beforePartialClose.length - 1
      const partialA = await waitForClientToMatchHost(
        clientA,
        remaining,
        worktreeId,
        RETRACTION_BUDGET_MS
      )
      const partialB = await waitForClientToMatchHost(
        clientB,
        remaining,
        worktreeId,
        RETRACTION_BUDGET_MS
      )
      console.error(`[two-client] phase1a host=${remaining} A=${partialA}ms B=${partialB}ms`)
      if (partialA === null || partialB === null) {
        failures.push(
          `phase1a: a client kept showing a terminal the host closed, with others still open (A=${partialA}, B=${partialB})`
        )
      }
    } else {
      // A one-terminal workspace would skip the control silently and let 1b/2 pass green on their own.
      failures.push(
        `phase1a: needs more than one host terminal to close one and keep another (host=${beforePartialClose.length})`
      )
    }

    for (const hostTabId of await readHostTerminalTabIds(clientA, worktreeId)) {
      await callEnvironment(clientA.page, clientA.environmentId, 'session.tabs.close', {
        worktree: `id:${worktreeId}`,
        tabId: hostTabId,
        reason: 'user',
        navigation: 'caller'
      })
    }
    await expect
      .poll(() => readHostTerminalTabIds(clientA!, worktreeId).then((ids) => ids.length), {
        timeout: MIRROR_BUDGET_MS,
        message: 'host still held terminals after client A closed them all'
      })
      .toBe(0)
    // Wait generously for any retraction; a never-removed mirror is still a dead pane.
    const emptyA = await waitForClientToMatchHost(clientA, 0, worktreeId, RETRACTION_BUDGET_MS)
    const emptyB = await waitForClientToMatchHost(clientB, 0, worktreeId, RETRACTION_BUDGET_MS)
    const hostOwnView = await readMirroredTabCount(orcaPage, worktreeId)
    console.error(
      `[two-client] phase1b host=0 hostOwnView=${hostOwnView}` +
        ` A=${emptyA}ms(${await readWorkspaceRowState(clientA.page, worktreeId)})` +
        ` B=${emptyB}ms(${await readWorkspaceRowState(clientB.page, worktreeId)})`
    )
    if (emptyA === null || emptyB === null) {
      failures.push(
        `phase1b: a client kept showing terminals the host no longer has (A=${emptyA}, B=${emptyB})`
      )
    }

    // Both clients hold explicit empty rows and must not automatically seed replacements.
    await orcaPage.waitForTimeout(10_000)
    const hostAfterSettle = (await readHostTerminalTabIds(clientA, worktreeId)).length
    console.error(`[two-client] phase1b-settled host=${hostAfterSettle}`)
    if (hostAfterSettle !== 0) {
      failures.push(
        `phase1b: the emptied workspace grew ${hostAfterSettle} terminal(s) back on its own`
      )
    }

    await callEnvironment(clientB.page, clientB.environmentId, 'session.tabs.createTerminal', {
      worktree: `id:${worktreeId}`,
      activate: true,
      select: true,
      navigation: 'caller'
    })
    const hostAfterB = (await readHostTerminalTabIds(clientB, worktreeId)).length
    const rejoinB = await waitForClientToMatchHost(
      clientB,
      hostAfterB,
      worktreeId,
      MIRROR_BUDGET_MS
    )
    const rejoinA = await waitForClientToMatchHost(
      clientA,
      hostAfterB,
      worktreeId,
      MIRROR_BUDGET_MS
    )
    console.error(`[two-client] phase2 host=${hostAfterB} A=${rejoinA}ms B=${rejoinB}ms`)
    if (rejoinA === null || rejoinB === null) {
      failures.push(
        `phase2: a client never adopted the terminal the host holds — the user sees an empty` +
          ` workspace while work runs on it (host=${hostAfterB}, A=${rejoinA}, B=${rejoinB})`
      )
    }
  } finally {
    await clientB?.dispose()
    await clientA?.dispose()
  }
  expect(failures, failures.join('\n')).toEqual([])
})

// Exercise immediate post-pairing close separately: it is a startup race, unlike the settled two-client journey.
test('a client that works immediately after pairing stays in step with the host', async ({
  orcaPage
}, testInfo) => {
  test.setTimeout(600_000)
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  const worktreeId = await orcaPage.evaluate(() => {
    const id = window.__store?.getState().activeWorktreeId
    if (!id) {
      throw new Error('host has no active worktree')
    }
    return id
  })

  let client: PairedElectronClient | null = null
  const failures: string[] = []
  try {
    client = await launchPairedElectronClient(
      await createRuntimeDesktopPairingOffer(orcaPage),
      testInfo,
      'fresh-pairing-immediate-work'
    )
    await waitForClientWorkspace(client.page, worktreeId)
    await focusWorkspace(client.page, worktreeId)

    await callEnvironment(client.page, client.environmentId, 'session.tabs.createTerminal', {
      worktree: `id:${worktreeId}`,
      activate: true,
      select: true,
      navigation: 'caller'
    })
    const afterCreate = (await readHostTerminalTabIds(client, worktreeId)).length
    const sawCreate = await waitForClientToMatchHost(
      client,
      afterCreate,
      worktreeId,
      MIRROR_BUDGET_MS
    )
    console.error(`[fresh-pairing] create host=${afterCreate} client=${sawCreate}ms`)
    if (sawCreate === null) {
      failures.push(
        `the client never mirrored the terminal it had just created (host=${afterCreate})`
      )
    }

    for (const hostTabId of await readHostTerminalTabIds(client, worktreeId)) {
      await callEnvironment(client.page, client.environmentId, 'session.tabs.close', {
        worktree: `id:${worktreeId}`,
        tabId: hostTabId,
        reason: 'user',
        navigation: 'caller'
      })
    }
    await expect
      .poll(() => readHostTerminalTabIds(client!, worktreeId).then((ids) => ids.length), {
        timeout: MIRROR_BUDGET_MS,
        message: 'host still held terminals after the client closed them all'
      })
      .toBe(0)
    const sawClose = await waitForClientToMatchHost(client, 0, worktreeId, MIRROR_BUDGET_MS)
    console.error(
      `[fresh-pairing] close client=${sawClose}ms row=${await readWorkspaceRowState(client.page, worktreeId)}`
    )
    if (sawClose === null) {
      failures.push('the client kept showing a terminal the host had already closed')
    }
  } finally {
    await client?.dispose()
  }
  expect(failures, failures.join('\n')).toEqual([])
})
