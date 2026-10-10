/**
 * TOPOLOGY (a): real Orca DESKTOP app as the remote server, isolated profile,
 * window ATTACHED, paired to a separate real desktop client.
 *
 * A terminal created by `orca terminal create` (RPC `terminal.create` ->
 * OrcaRuntimeService.createTerminal) must survive the renderer graph syncs that
 * every later CLI dispatch drives. The renderer never owns that pane, so it is
 * absent from every renderer publication; the daemon ptyId form
 * `<worktreeId>@@<shortUuid>` is excluded from id-shape classification; and the
 * tab inherits the RENDERER's publicationEpoch, so epoch alone cannot save it.
 *
 * The window is causal: the old gate was `getAvailableAuthoritativeWindow() ===
 * null`, so a windowless host does NOT reproduce this (see the serve parity
 * arm). The renderer-first publication is equally load-bearing — on a workspace
 * only the host published, the snapshot carries a headless epoch, which is
 * preserved unconditionally. Both preconditions are asserted, not assumed.
 *
 * WHAT THIS ORACLE CAN AND CANNOT SEE. It reads the host inventory after ONE
 * renderer graph sync, and that made an earlier four-row matrix here read as if
 * a preceding host terminal or a `clientMutationId` "protected" the tab. Both
 * readings were false negatives. Main-process instrumentation showed the
 * renderer's stale session write deleted the host tab from persistence in EVERY
 * variant; the only difference was whether that delete landed before or after
 * the sync being measured. The apparently-protected tabs were already gone from
 * persistence — they would prune on the next sync and were lost across restart.
 * Read a single-sync retained verdict as "not yet pruned", never as "safe".
 *
 * The defect that produced those rows was in persistence, not in the graph-sync
 * reconciler: persistPtyBinding refused to raise the repo's terminal topology
 * fence for the first host-admitted tab, so the renderer's pre-create tab list
 * replayed over it (fixed in `let a host-admitted tab establish membership
 * authority`). Elapsed time never decided anything, and neither did whether a
 * paired client had mirrored the tab.
 *
 * Run:
 *   pnpm exec playwright test tests/e2e/paired-cli-terminal-graph-sync-tab-retention.spec.ts \
 *     --config tests/playwright.config.ts --project electron-headless --workers=1
 */
import { rmSync } from 'node:fs'
import path from 'node:path'
import type { Page, TestInfo } from '@stablyai/playwright-test'
import {
  toWebTerminalSurfaceTabId,
  WEB_TERMINAL_SURFACE_TAB_PREFIX
} from '../../src/shared/terminal-surface-id'
import { expect, test } from './helpers/orca-app'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import {
  createHostCliTerminal,
  createHostRendererTerminalTab,
  createRetentionFixtureDirectory,
  proveSameLivePty,
  readHostInventoryWhenTabAppears,
  readHostTerminalInventory,
  writeRetentionFixture,
  type HostCreatedTerminal,
  type RuntimeRpcCall
} from './helpers/host-created-terminal-retention-oracle'

const scratch = createRetentionFixtureDirectory()
const fixturePath = writeRetentionFixture(scratch)

test.afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

function createPairedRuntimeCall(page: Page, environmentId: string): RuntimeRpcCall {
  return async <TResult>(method: string, params: unknown): Promise<TResult> =>
    page.evaluate(
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

async function readClientTerminalStrip(page: Page, worktreeId: string): Promise<string[]> {
  return page.evaluate(
    ({ worktreeId, prefix }) =>
      (window.__store?.getState().tabsByWorktree[worktreeId] ?? [])
        .map((tab) => tab.id)
        .filter((tabId) => tabId.startsWith(prefix)),
    { worktreeId, prefix: WEB_TERMINAL_SURFACE_TAB_PREFIX }
  )
}

/** The strip exactly as it read on the poll tick that first carried `tabId`. */
async function readClientStripWhenTabAppears(
  page: Page,
  worktreeId: string,
  tabId: string,
  message: string
): Promise<string[]> {
  let strip: string[] = []
  await expect
    .poll(
      async () => {
        strip = await readClientTerminalStrip(page, worktreeId)
        return strip.includes(tabId)
      },
      { timeout: 60_000, message }
    )
    .toBe(true)
  return strip
}

type RetentionFixture = {
  call: RuntimeRpcCall
  unrelatedWorktreeId: string
  worktreeId: string
}

/** Everything both journeys need in place BEFORE the dispatch under test. */
async function prepareRetentionFixture(
  orcaPage: Page,
  client: PairedElectronClient
): Promise<RetentionFixture> {
  const call = createPairedRuntimeCall(client.page, client.environmentId)
  const { worktreeId, unrelatedWorktreeId } = await orcaPage.evaluate(() => {
    const state = window.__store?.getState()
    const active = state?.activeWorktreeId
    if (!state || !active) {
      throw new Error('Host has no active worktree')
    }
    const unrelated = state.allWorktrees().find((worktree) => worktree.id !== active)
    if (!unrelated) {
      throw new Error('Host fixture needs a second worktree for the unrelated-workspace control')
    }
    return { worktreeId: active, unrelatedWorktreeId: unrelated.id }
  })
  await expect
    .poll(
      () =>
        client.page.evaluate(
          (id) =>
            window.__store
              ?.getState()
              .allWorktrees()
              .some((worktree) => worktree.id === id) ?? false,
          worktreeId
        ),
      { timeout: 60_000, message: 'Paired client never saw the host worktree' }
    )
    .toBe(true)

  // PRECONDITION: the RENDERER owns this workspace's publication, so the CLI tab
  // created later inherits the renderer epoch instead of a headless one.
  const rendererTabId = await createHostRendererTerminalTab(orcaPage, worktreeId)
  const rendererOwned = await readHostInventoryWhenTabAppears(
    call,
    worktreeId,
    rendererTabId,
    'Host never published the renderer terminal tab'
  )
  expect(
    rendererOwned.publicationEpoch,
    'the attached-window topology requires a renderer-owned publication; a headless epoch takes a different, already-correct path'
  ).toMatch(/^renderer:/)
  await readClientStripWhenTabAppears(
    client.page,
    worktreeId,
    toWebTerminalSurfaceTabId(rendererTabId),
    'Paired client never mirrored the host renderer terminal tab'
  )
  return { call, unrelatedWorktreeId, worktreeId }
}

/**
 * One `orca terminal create` in the measured workspace, one renderer graph sync,
 * both signals plus the negative-safety checks.
 *
 * `precedingHostTerminal` is the ONLY difference between the two tests: the
 * unrelated-workspace control terminal is created either before the target or
 * after it, so `false` makes the target the repo's first host-admitted tab —
 * the incident shape, and the one the topology fence used to miss.
 */
async function runCliTerminalRetentionJourney(
  orcaPage: Page,
  testInfo: TestInfo,
  clientName: string,
  precedingHostTerminal: boolean
): Promise<void> {
  const client = await launchPairedElectronClient(
    await createRuntimeDesktopPairingOffer(orcaPage),
    testInfo,
    clientName
  )
  const hostPageErrors: string[] = []
  const clientPageErrors: string[] = []
  orcaPage.on('pageerror', (error) => hostPageErrors.push(String(error)))
  client.page.on('pageerror', (error) => clientPageErrors.push(String(error)))
  const createdHandles: string[] = []
  let call: RuntimeRpcCall | null = null
  try {
    const fixture = await prepareRetentionFixture(orcaPage, client)
    call = fixture.call
    const { unrelatedWorktreeId, worktreeId } = fixture
    const baselineStrip = await readClientTerminalStrip(client.page, worktreeId)

    const createUnrelated = async (): Promise<HostCreatedTerminal> => {
      const terminal = await createHostCliTerminal(
        fixture.call,
        unrelatedWorktreeId,
        fixturePath,
        path.join(scratch, `${clientName}-unrelated.log`)
      )
      createdHandles.push(terminal.handle)
      return terminal
    }

    const preceding = precedingHostTerminal ? await createUnrelated() : null
    const cli = await createHostCliTerminal(
      fixture.call,
      worktreeId,
      fixturePath,
      path.join(scratch, `${clientName}-target.log`)
    )
    createdHandles.push(cli.handle)
    const unrelated = preceding ?? (await createUnrelated())

    // The graph sync a following CLI dispatch drives.
    const secondRendererTabId = await createHostRendererTerminalTab(orcaPage, worktreeId)

    // SIGNAL 1 — the frame carrying the new renderer tab is the same merge that
    // would drop the CLI tab, so judge on that one inventory.
    const afterSync = await readHostInventoryWhenTabAppears(
      fixture.call,
      worktreeId,
      secondRendererTabId,
      'Host never republished with the second renderer tab'
    )
    expect(
      afterSync.tabIds,
      'the renderer graph sync pruned the CLI-created terminal out of the host session inventory'
    ).toContain(cli.tabId)
    expect(
      afterSync.ptyIdByTabId[cli.tabId],
      'the surviving tab must still name the original PTY, not a replacement'
    ).toBe(cli.ptyId)

    // SIGNAL 2 — independent of the inventory: the original process answers.
    await proveSameLivePty(fixture.call, cli, 'after-sync')

    // The paired client tracked that same sync. Presence alone would pass on a
    // stranded mirror, which is exactly what the unfixed host produces.
    const strip = await readClientStripWhenTabAppears(
      client.page,
      worktreeId,
      toWebTerminalSurfaceTabId(secondRendererTabId),
      'Paired client never applied the renderer graph sync that followed the CLI create'
    )
    expect(strip, 'the paired client dropped the CLI-created terminal from its strip').toContain(
      toWebTerminalSurfaceTabId(cli.tabId)
    )
    // No replacement or resume tab was appended for it either.
    expect([...strip].sort()).toEqual(
      [
        ...baselineStrip,
        toWebTerminalSurfaceTabId(cli.tabId),
        toWebTerminalSurfaceTabId(secondRendererTabId)
      ].sort()
    )

    // NEGATIVE SAFETY: no fanout into an unrelated workspace, no local fallback.
    const unrelatedInventory = await readHostTerminalInventory(fixture.call, unrelatedWorktreeId)
    expect(unrelatedInventory.tabIds, 'an unrelated workspace lost its CLI terminal').toContain(
      unrelated.tabId
    )
    expect(unrelatedInventory.ptyIdByTabId[unrelated.tabId]).toBe(unrelated.ptyId)
    await proveSameLivePty(fixture.call, unrelated, 'unrelated-alive')
    expect(
      await client.getDirectSshAttemptTargetIds(),
      'the paired client must reach the host through the pairing, never a local connection'
    ).toEqual([])
    expect(hostPageErrors, 'host renderer raised an uncaught error').toEqual([])
    expect(clientPageErrors, 'paired client renderer raised an uncaught error').toEqual([])
  } finally {
    for (const handle of createdHandles) {
      await call?.('terminal.closeTab', { terminal: handle }).catch(() => undefined)
    }
    await client.dispose()
  }
}

test('keeps a host-created CLI terminal when an earlier host-created terminal exists', async ({
  orcaPage
}, testInfo) => {
  test.setTimeout(600_000)
  await runCliTerminalRetentionJourney(orcaPage, testInfo, 'cli-terminal-graph-sync', true)
})

// The reported incident, and the shape the real CLI takes: `orca terminal
// create` sends no clientMutationId, so this is a user's FIRST host-created
// terminal in the repo — the one case that raised no topology fence and whose
// tab the renderer's pre-create tab list therefore replayed out of persistence.
// Reverting store.ts/pty.ts alone turns this red with SIGNAL 1: the target is
// absent from the host inventory.
test('keeps a host-created CLI terminal that is the first one on the host', async ({
  orcaPage
}, testInfo) => {
  test.setTimeout(600_000)
  await runCliTerminalRetentionJourney(orcaPage, testInfo, 'cli-terminal-graph-sync-first', false)
})
