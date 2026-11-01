// Use an attached desktop host and separate paired desktop; assert renderer-first publication so the host-created daemon @@ tab inherits its epoch.
// Renderer snapshots omit that CLI pane; a headless epoch or windowless host would miss the original persistence-fence failure.
// One retained inventory after sync means only not-yet-pruned: stale writes can delete persistence before later sync/restart.
// The first host-admitted tab must raise the topology fence; neither clientMutationId nor preceding tabs independently protects it.
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

  // Require renderer publication before CLI create so a headless epoch cannot protect the tab.
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

// Measure one CLI create and renderer sync with inventory/process and unrelated-workspace checks.
// Only precedingHostTerminal differs: false makes the target the repo’s first host-admitted tab, the original missing-fence case.
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

    const secondRendererTabId = await createHostRendererTerminalTab(orcaPage, worktreeId)

    // Judge the same inventory frame that adds the renderer tab and could drop the CLI tab.
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

    await proveSameLivePty(fixture.call, cli, 'after-sync')

    // Require the paired client to track this sync; a stranded mirror alone still shows the old tab.
    const strip = await readClientStripWhenTabAppears(
      client.page,
      worktreeId,
      toWebTerminalSurfaceTabId(secondRendererTabId),
      'Paired client never applied the renderer graph sync that followed the CLI create'
    )
    expect(strip, 'the paired client dropped the CLI-created terminal from its strip').toContain(
      toWebTerminalSurfaceTabId(cli.tabId)
    )
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

// The real CLI omits clientMutationId: its first host-admitted tab must establish persistence authority.
// Reverting store.ts/pty.ts fails at host inventory retention.
test('keeps a host-created CLI terminal that is the first one on the host', async ({
  orcaPage
}, testInfo) => {
  test.setTimeout(600_000)
  await runCliTerminalRetentionJourney(orcaPage, testInfo, 'cli-terminal-graph-sync-first', false)
})
