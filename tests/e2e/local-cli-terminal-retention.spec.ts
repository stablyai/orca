/**
 * TOPOLOGY (c): ONE real Orca desktop app, isolated profile, window ATTACHED,
 * NO paired client — `orca terminal create` over the local runtime socket,
 * which is the transport the shipped CLI uses.
 *
 * Pairing is not what made the paired arm reproduce: `shouldCreateInBackground`
 * is true for ANY create with a worktree selector, no focus request and
 * `rendererBacked !== true`, so a plain local dispatch lands on the same seam.
 * The target is created before any other host terminal, making it the repo's
 * FIRST host-admitted tab — the shape the old `currentRevision <= 0` fence
 * missed. A renderer-owned publication is a precondition, not scenery, and is
 * asserted: a host-only workspace carries a headless epoch and is already safe.
 *
 * Losing the tab is only half the incident. The sleeping-agent record outlives
 * it, so `recordPaneIsOwnedByPreservedPane` reads "no such tab" and the next
 * activation sweep forks the session into a ghost tab. The CLI pane's record is
 * reported live; a second record, on a pane that genuinely does not exist, is
 * written into the stopped profile before the relaunch. That one MUST be
 * replayed, which is what makes the CLI pane's silence evidence rather than a
 * sweep that never ran. It is seeded on disk because a layout-owner build keeps
 * resume records on the panes main holds, so a record for no pane can only come
 * from a loaded profile.
 *
 * Run:
 *   npx playwright test tests/e2e/local-cli-terminal-retention.spec.ts \
 *     --config tests/playwright.config.ts --project electron-headless --workers=1
 */ import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { RuntimeClient } from '../../src/cli/runtime-client'
import { makePaneKey } from '../../src/shared/stable-pane-id'
import { expect, test } from './helpers/orca-app'
import { TEST_REPO_PATH_FILE } from './global-setup'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { mutateStoppedProfileState } from './helpers/persisted-profile-state'
import { waitForSessionReady } from './helpers/store'
import {
  createHostCliTerminal,
  createHostRendererTerminalTab,
  createRetentionFixtureDirectory,
  proveSameLivePty,
  readHostInventoryWhenTabAppears,
  readHostTerminalInventory,
  writeRetentionFixture,
  type RuntimeRpcCall
} from './helpers/host-created-terminal-retention-oracle'

const scratch = createRetentionFixtureDirectory()
const fixturePath = writeRetentionFixture(scratch)

const CLI_PANE_SESSION_ID = 'local-cli-retention-cli-pane'
const ABSENT_PANE_SESSION_ID = 'local-cli-retention-absent-pane'

test.afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

/** The runtime's worktree scan lands after first paint, so the renderer knows a
 *  workspace before any selector resolves against it. */
async function waitForLocalRuntimeWorktree(
  call: RuntimeRpcCall,
  worktreeId: string
): Promise<void> {
  await expect
    .poll(
      async () =>
        call('worktree.show', { worktree: `id:${worktreeId}` }).then(
          () => true,
          () => false
        ),
      {
        timeout: 120_000,
        message: `local runtime never resolved worktree ${worktreeId}`
      }
    )
    .toBe(true)
}

type WorktreeTabSnapshot = {
  tabIds: string[]
  resumeTabIds: string[]
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** The stopped profile's resume records, as the live object a mutation writes through. */
function sleepingRecordsOf(state: Record<string, unknown>): Record<string, unknown> {
  const session = state.workspaceSession
  if (!isObject(session)) {
    throw new Error('The stopped profile has no workspace session')
  }
  const existing = session.sleepingAgentSessionsByPaneKey
  const records = isObject(existing) ? existing : {}
  session.sleepingAgentSessionsByPaneKey = records
  return records
}

/** The fixture's external worktree is hidden on a new repo; the unrelated-workspace control needs it. */
async function showSeededWorktrees(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const store = window.__store
          const repo = store?.getState().repos[0]
          if (!store || !repo) {
            return 0
          }
          await store.getState().updateRepo(repo.id, { externalWorktreeVisibility: 'show' })
          await store.getState().fetchWorktrees(repo.id)
          return store.getState().allWorktrees().length
        }),
      { timeout: 30_000, message: 'seeded e2e worktrees did not load' }
    )
    .toBeGreaterThan(1)
}

function runtimeCall(userDataDir: string): RuntimeRpcCall {
  // The shipped CLI's own transport, against this app's profile: no pairing.
  const client = new RuntimeClient(userDataDir, 30_000, null, null)
  return async <TResult>(method: string, params: unknown) =>
    (await client.call<TResult>(method, params)).result
}

test('keeps a locally created CLI terminal, and never resumes it as a ghost', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
{}, testInfo) => {
  test.setTimeout(600_000)
  const repoPath = readFileSync(TEST_REPO_PATH_FILE, 'utf-8').trim()
  if (!repoPath || !existsSync(repoPath)) {
    test.skip(true, 'Global setup did not produce a seeded test repo')
    return
  }
  const pageErrors: string[] = []
  const session = createRestartSession(testInfo)
  let app: ElectronApplication | null = null
  let call: RuntimeRpcCall | null = null
  const createdHandles: string[] = []

  try {
    const firstLaunch = await session.launch()
    app = firstLaunch.app
    const firstPage = firstLaunch.page
    firstPage.on('pageerror', (error) => pageErrors.push(String(error)))
    const worktreeId = await attachRepoAndOpenTerminal(firstPage, repoPath)
    await waitForSessionReady(firstPage)
    await showSeededWorktrees(firstPage)
    const unrelatedWorktreeId = await firstPage.evaluate((active) => {
      const unrelated = window.__store
        ?.getState()
        .allWorktrees()
        .find((worktree) => worktree.id !== active)
      if (!unrelated) {
        throw new Error('Host fixture needs a second worktree for the unrelated-workspace control')
      }
      return unrelated.id
    }, worktreeId)
    call = runtimeCall(session.userDataDir)

    await waitForLocalRuntimeWorktree(call, worktreeId)
    await waitForLocalRuntimeWorktree(call, unrelatedWorktreeId)

    // PRECONDITION: the RENDERER owns this workspace's publication, so the CLI
    // tab created next inherits the renderer epoch instead of a headless one.
    const rendererTabId = await createHostRendererTerminalTab(firstPage, worktreeId)
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
    const baselineTabIds = [...rendererOwned.tabIds].sort()

    const cli = await createHostCliTerminal(
      call,
      worktreeId,
      fixturePath,
      path.join(scratch, 'local-target.log')
    )
    createdHandles.push(cli.handle)
    const unrelated = await createHostCliTerminal(
      call,
      unrelatedWorktreeId,
      fixturePath,
      path.join(scratch, 'local-unrelated.log')
    )
    createdHandles.push(unrelated.handle)

    // The graph sync a following CLI dispatch drives.
    const secondRendererTabId = await createHostRendererTerminalTab(firstPage, worktreeId)

    // SIGNAL 1 — the frame carrying the new renderer tab is the same merge that
    // would drop the CLI tab, so judge on that one inventory.
    const afterSync = await readHostInventoryWhenTabAppears(
      call,
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
    await proveSameLivePty(call, cli, 'after-sync')

    // Nothing was appended either: a replacement or resume tab would also
    // satisfy "the CLI tab is present".
    expect(
      [...afterSync.tabIds].sort(),
      'the workspace gained or lost a terminal tab across the graph sync'
    ).toEqual([...baselineTabIds, cli.tabId, secondRendererTabId].sort())

    // NEGATIVE SAFETY: no fanout into an unrelated workspace.
    const unrelatedInventory = await readHostTerminalInventory(call, unrelatedWorktreeId)
    expect(unrelatedInventory.tabIds, 'an unrelated workspace lost its CLI terminal').toContain(
      unrelated.tabId
    )
    expect(unrelatedInventory.ptyIdByTabId[unrelated.tabId]).toBe(unrelated.ptyId)
    await proveSameLivePty(call, unrelated, 'unrelated-alive')

    const cliPaneKey = makePaneKey(cli.tabId, cli.leafId)
    // Why: a real agent reports its provider session over the hook server;
    // writing the same store entry keeps this hermetic on the identical path.
    await firstPage.evaluate(
      ({ paneKey, sessionId, worktreeId }) => {
        window.__store?.getState().setAgentStatus(
          paneKey,
          {
            state: 'working',
            prompt: 'local cli retention',
            agentType: 'claude'
          },
          'Claude',
          undefined,
          { worktreeId },
          { providerSession: { key: 'session_id', id: sessionId } }
        )
      },
      { paneKey: cliPaneKey, sessionId: CLI_PANE_SESSION_ID, worktreeId }
    )
    await expect
      .poll(
        () =>
          firstPage.evaluate(
            (paneKey) =>
              window.__store?.getState().sleepingAgentSessionsByPaneKey[paneKey] !== undefined,
            cliPaneKey
          ),
        { timeout: 30_000, message: 'the seeded provider session never became a sleeping record' }
      )
      .toBe(true)

    // The resume sweep runs once per worktree per Terminal mount; a relaunch puts the retained
    // pane in front of it. The daemon, and with it the CLI terminal's process, stays up.
    await session.close(app)
    app = null

    // The control: a record whose pane is gone, i.e. what the pruned CLI tab
    // would leave behind. Its replay is the proof the sweep ran at all.
    const absentTabId = randomUUID()
    const absentPaneKey = makePaneKey(absentTabId, randomUUID())
    mutateStoppedProfileState(session.userDataDir, (state) => {
      const records = sleepingRecordsOf(state)
      const cliRecord = records[cliPaneKey]
      if (!isObject(cliRecord)) {
        throw new Error('the CLI pane reported a session, so quit must save its record')
      }
      records[absentPaneKey] = {
        ...cliRecord,
        paneKey: absentPaneKey,
        tabId: absentTabId,
        providerSession: { key: 'session_id', id: ABSENT_PANE_SESSION_ID }
      }
    })

    const secondLaunch = await session.launch()
    app = secondLaunch.app
    const orcaPage = secondLaunch.page
    orcaPage.on('pageerror', (error) => pageErrors.push(String(error)))
    call = runtimeCall(session.userDataDir)
    await waitForSessionReady(orcaPage)
    await expect
      .poll(() => orcaPage.evaluate(() => window.__store?.getState().activeWorktreeId), {
        timeout: 60_000,
        message: 'relaunched renderer never reactivated the measured worktree'
      })
      .toBe(worktreeId)

    const readWorktreeTabs = async (): Promise<WorktreeTabSnapshot> =>
      orcaPage.evaluate((worktreeId) => {
        const tabs = window.__store?.getState().tabsByWorktree[worktreeId] ?? []
        return {
          tabIds: tabs.map((tab) => tab.id),
          resumeTabIds: tabs.filter((tab) => tab.launchAgent === 'claude').map((tab) => tab.id)
        }
      }, worktreeId)
    // CONTROL: the absent pane's record must be replayed, which is what makes
    // the CLI pane's silence below evidence instead of a sweep that never ran.
    await expect
      .poll(async () => (await readWorktreeTabs()).resumeTabIds.length > 0, {
        timeout: 60_000,
        message: 'the activation sweep never replayed the record whose pane is gone'
      })
      .toBe(true)
    const resumed = await readWorktreeTabs()
    expect(
      resumed.resumeTabIds,
      'the sweep replayed more than the one record whose pane is gone'
    ).toHaveLength(1)
    expect(
      resumed.tabIds,
      'the retained CLI tab did not survive the relaunch the resume sweep runs on'
    ).toContain(cli.tabId)
    // Main's inventory, not the window's tab: a layout-owner window names a hidden tab's PTY on mount.
    expect(
      (await readHostTerminalInventory(call, worktreeId)).ptyIdByTabId[cli.tabId],
      'the relaunched CLI tab must still name the original PTY, not a replacement'
    ).toBe(cli.ptyId)
    await proveSameLivePty(call, cli, 'after-relaunch')
    expect(
      await orcaPage.evaluate(
        (paneKey) =>
          window.__store?.getState().sleepingAgentSessionsByPaneKey[paneKey] !== undefined,
        cliPaneKey
      ),
      'the CLI pane owns its session, so its record must still be asleep, not consumed by a resume'
    ).toBe(true)
    expect(
      resumed.tabIds.filter((tabId) => !baselineTabIds.includes(tabId)).sort(),
      'the relaunched workspace carries a tab no step of this journey created'
    ).toEqual([cli.tabId, secondRendererTabId, resumed.resumeTabIds[0]!].sort())

    expect(pageErrors, 'host renderer raised an uncaught error').toEqual([])
  } finally {
    for (const handle of createdHandles) {
      await call?.('terminal.closeTab', { terminal: handle }).catch(() => undefined)
    }
    if (app) {
      await session.close(app)
    }
    await session.dispose()
  }
})
