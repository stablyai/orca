/**
 * TOPOLOGY (b): isolated windowless `orca serve` host, paired to a separate
 * real desktop client. Parity arm for
 * paired-cli-terminal-graph-sync-tab-retention.spec.ts, which covers the
 * attached-window desktop host; both import the same oracle unchanged so
 * neither topology can be claimed to prove the other by accident.
 *
 * This host CANNOT exhibit the desktop defect, and that is the point of the
 * arm rather than a weakness of it: the old gate was
 * `getAvailableAuthoritativeWindow() === null`, so a windowless host already
 * persisted the binding on main, and with no renderer there is no renderer
 * graph sync to prune anything. The spec therefore asserts the topology
 * (a headless publication epoch, never a renderer one) and then the
 * no-regression claim that matters now the persist is unconditional: further
 * CLI dispatches must leave every earlier host-created terminal in the host
 * inventory, still bound to its original PTY and still answering.
 *
 * Run:
 *   pnpm exec playwright test tests/e2e/headless-serve-cli-terminal-retention-parity.spec.ts \
 *     --config tests/playwright.config.ts --project electron-headless --workers=1
 */
import { rmSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import {
  toWebTerminalSurfaceTabId,
  WEB_TERMINAL_SURFACE_TAB_PREFIX
} from '../../src/shared/terminal-surface-id'
import { expect, test } from './helpers/orca-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import { launchPairedElectronClient } from './helpers/paired-electron-client'
import {
  createHostCliTerminal,
  createRetentionFixtureDirectory,
  proveSameLivePty,
  readHostTerminalInventory,
  writeRetentionFixture,
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

async function waitForClientTab(page: Page, worktreeId: string, tabId: string): Promise<void> {
  await expect
    .poll(async () => (await readClientTerminalStrip(page, worktreeId)).includes(tabId), {
      timeout: 60_000,
      message: `Paired client never mirrored serve-host tab ${tabId}`
    })
    .toBe(true)
}

test('keeps every host-created CLI terminal on a windowless serve host', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(600_000)
  const host = await launchHeadlessPairedRuntimeHost()
  const client = await launchPairedElectronClient(
    host.offer,
    testInfo,
    'headless-cli-terminal-retention'
  ).catch(async (error) => {
    await host.dispose()
    throw error
  })
  const clientPageErrors: string[] = []
  client.page.on('pageerror', (error) => clientPageErrors.push(String(error)))
  const call = createPairedRuntimeCall(client.page, client.environmentId)
  try {
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
        { timeout: 30_000, message: 'Serve host never listed a worktree for the seeded repo' }
      )
      .not.toBe('')
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
        { timeout: 60_000, message: 'Paired client never saw the serve-host worktree' }
      )
      .toBe(true)

    const first = await createHostCliTerminal(
      call,
      worktreeId,
      fixturePath,
      path.join(scratch, 'headless-first.log')
    )
    const published = await readHostTerminalInventory(call, worktreeId)
    expect(published.tabIds, 'serve host never published the CLI-created terminal').toContain(
      first.tabId
    )
    // TOPOLOGY ASSERTION: with no renderer there is no renderer-owned
    // publication to inherit, which is precisely why this host cannot reach the
    // window-conditioned prune the desktop arm reproduces.
    expect(
      published.publicationEpoch,
      'a windowless serve host must publish under a headless epoch; a renderer epoch would mean this arm is not testing the headless path'
    ).toMatch(/^headless/)
    await waitForClientTab(client.page, worktreeId, toWebTerminalSurfaceTabId(first.tabId))
    await proveSameLivePty(call, first, 'headless-first-alive')

    // The next dispatch, i.e. what the remote agent does when it spawns more
    // agents. On this host it is the only thing that republishes the worktree.
    const second = await createHostCliTerminal(
      call,
      worktreeId,
      fixturePath,
      path.join(scratch, 'headless-second.log')
    )
    expect(second.ptyId).not.toBe(first.ptyId)
    await waitForClientTab(client.page, worktreeId, toWebTerminalSurfaceTabId(second.tabId))

    // SIGNAL 1 — the host inventory still carries both, each still naming the
    // PTY it was created with.
    const afterSecond = await readHostTerminalInventory(call, worktreeId)
    expect(
      afterSecond.tabIds,
      'a later CLI dispatch dropped the earlier host-created terminal from the serve-host inventory'
    ).toContain(first.tabId)
    expect(afterSecond.tabIds).toContain(second.tabId)
    expect(
      afterSecond.ptyIdByTabId[first.tabId],
      'the retained tab must still name its original PTY, not a replacement'
    ).toBe(first.ptyId)
    expect(afterSecond.ptyIdByTabId[second.tabId]).toBe(second.ptyId)

    // SIGNAL 2 — independent of the inventory: both original processes answer.
    await proveSameLivePty(call, first, 'headless-first-after-second')
    await proveSameLivePty(call, second, 'headless-second-alive')

    // NEGATIVE SAFETY: the client mirrors exactly these two and nothing else —
    // no replacement or resume tab was appended for either.
    expect((await readClientTerminalStrip(client.page, worktreeId)).sort()).toEqual(
      [toWebTerminalSurfaceTabId(first.tabId), toWebTerminalSurfaceTabId(second.tabId)].sort()
    )
    expect(
      await client.getDirectSshAttemptTargetIds(),
      'the paired client must reach the serve host through the pairing, never a local connection'
    ).toEqual([])
    expect(clientPageErrors, 'paired client renderer raised an uncaught error').toEqual([])
  } finally {
    await client.dispose()
    await host.dispose()
  }
})
