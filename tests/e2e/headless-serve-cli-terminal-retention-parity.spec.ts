// Run the same retention oracle against a windowless serve host and the paired desktop topology.
// Without renderer graph publication, this arm proves headless parity rather than the desktop prune regression.
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
    // Require a headless publication epoch so this arm cannot accidentally exercise renderer-owned publication.
    expect(
      published.publicationEpoch,
      'a windowless serve host must publish under a headless epoch; a renderer epoch would mean this arm is not testing the headless path'
    ).toMatch(/^headless/)
    await waitForClientTab(client.page, worktreeId, toWebTerminalSurfaceTabId(first.tabId))
    await proveSameLivePty(call, first, 'headless-first-alive')

    // Dispatch again to republish the worktree and expose any loss of earlier terminals.
    const second = await createHostCliTerminal(
      call,
      worktreeId,
      fixturePath,
      path.join(scratch, 'headless-second.log')
    )
    expect(second.ptyId).not.toBe(first.ptyId)
    await waitForClientTab(client.page, worktreeId, toWebTerminalSurfaceTabId(second.tabId))

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
