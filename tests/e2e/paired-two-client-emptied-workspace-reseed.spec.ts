/**
 * JOURNEY: two desktop clients paired to one Orca server, working in the same workspace.
 *
 * TOPOLOGY: the `orcaPage` app is the host (orca server). Two separate real Orca desktop
 * clients pair to it, exactly as two of the user's machines would. Nothing is faulted — this
 * is the ordinary shape of using Orca from a laptop and a desktop at the same time.
 *
 * The emptied-workspace tombstone is an explicit `tabsByWorktree[worktreeId] = []` row and it
 * is client-local on the runtime path: it never crosses the wire, so the second client cannot
 * know the first emptied the workspace on purpose and still seeds into it. That asymmetry is
 * by design. What is NOT by design is a client falling out of step with the host and staying
 * there, which is what this spec measures.
 *
 * Phase 0 is the control: with both clients attached, does a terminal created on one reach the
 * other at all? Without it a later divergence cannot be attributed to the emptying.
 *
 * KNOWN RED as of this commit, and the shape of the failure is the finding. Across 8 runs the
 * close phases were all-or-nothing: either every retraction reached both clients in single-digit
 * milliseconds, or none reached either client within 90 seconds — and phase 1a, which closes a
 * terminal while others remain open, fails alongside phase 1b, so it is not about the workspace
 * going empty. Creates always propagate, including the phase 2 create that lands in ~3ms on the
 * very clients that just missed a close for 90s, so the subscription is demonstrably alive. Both
 * clients failing together, while the host's own window shows the correct count, puts the fault
 * on the host's publish-after-close rather than on any client's mirror. What the user sees: a
 * terminal they closed on one machine stays in the tab bar on the other, pointing at a process
 * that no longer exists, until some unrelated change to the workspace forces a republish.
 *
 * Run:
 *   pnpm exec playwright test \
 *     tests/e2e/paired-two-client-emptied-workspace-reseed.spec.ts \
 *     --config tests/playwright.config.ts --project electron-headless --workers=1
 */
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

    // ── Phase 0: the control. A creates a terminal; B must see it. ──
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

    // ── Phase 1a: A closes one terminal, but not the last one. ──
    // Separated from the emptying below on purpose: it is the control that says whether a
    // retraction propagates at all, so a failure in 1b can be attributed to the workspace going
    // empty rather than to close retractions being broken in general.
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
    }

    // ── Phase 1b: A empties the workspace by hand. ──
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
    // Deliberately generous: the question is whether the retraction ever arrives, not whether
    // it is prompt. A client still showing a terminal the host has destroyed is a dead pane the
    // user will click.
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

    // Neither client may seed a replacement into a workspace the user deliberately emptied:
    // both hold a row for it, so both know it was emptied rather than never initialized.
    await orcaPage.waitForTimeout(10_000)
    const hostAfterSettle = (await readHostTerminalTabIds(clientA, worktreeId)).length
    console.error(`[two-client] phase1b-settled host=${hostAfterSettle}`)
    if (hostAfterSettle !== 0) {
      failures.push(
        `phase1b: the emptied workspace grew ${hostAfterSettle} terminal(s) back on its own`
      )
    }

    // ── Phase 2: B creates a terminal again. Both clients must follow the host. ──
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

/**
 * The same workspace, driven by a client that starts working the moment it finishes pairing —
 * which is what a user does on a machine they have just added.
 *
 * Isolated from the two-client test above because the failure it hunts is a startup race, not a
 * multi-client one: the earlier form of that test drove the close seconds after the pairing
 * completed and repeatedly left the client's mirror stuck — sometimes still showing the terminal
 * the host had closed, sometimes stuck empty afterwards — with the link demonstrably alive.
 */
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
