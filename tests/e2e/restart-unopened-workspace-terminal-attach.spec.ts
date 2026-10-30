// A terminal that survives a quit in a workspace the window never opened must stream to main after relaunch.
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { RuntimeClient } from '../../src/cli/runtime-client'
import type { RuntimeTerminalSummary } from '../../src/shared/runtime-types'
import { expect, test } from './helpers/orca-app'
import { TEST_REPO_PATH_FILE } from './global-setup'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { createRetentionFixtureDirectory } from './helpers/host-created-terminal-retention-oracle'

const scratch = createRetentionFixtureDirectory()
const printerPath = path.join(scratch, 'printer.mjs')
writeFileSync(
  printerPath,
  'setInterval(() => process.stdout.write(`tick ${Date.now()}\\r\\n`), 250)\n'
)
test.afterAll(() => rmSync(scratch, { recursive: true, force: true }))

type RuntimeCall = <T>(method: string, params?: unknown) => Promise<T>

async function launchWithUnopenedWorkspace(session: ReturnType<typeof createRestartSession>) {
  const repoPath = readFileSync(TEST_REPO_PATH_FILE, 'utf-8').trim()
  const { app } = await session.launch()
  const page = await app.firstWindow()
  const active = await attachRepoAndOpenTerminal(page, repoPath)
  await waitForSessionReady(page)
  const call: RuntimeCall = async <T>(method: string, params?: unknown) =>
    (await new RuntimeClient(session.userDataDir, 30_000, null, null).call<T>(method, params))
      .result
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const state = window.__store!.getState()
          await state.fetchWorktrees(state.repos[0]!.id)
          return window.__store!.getState().allWorktrees().length
        }),
      { timeout: 60_000 }
    )
    .toBeGreaterThan(1)
  const unopened = await page.evaluate(
    (activeId) =>
      window
        .__store!.getState()
        .allWorktrees()
        .find((worktree) => worktree.id !== activeId)!.id,
    active
  )
  await expect
    .poll(
      () =>
        call('worktree.show', { worktree: `id:${unopened}` }).then(
          () => true,
          () => false
        ),
      { timeout: 120_000 }
    )
    .toBe(true)
  return { app, page, call, active, unopened }
}

// Scoped to one workspace: an unscoped list refuses while any other pane is still binding its PTY.
function listTerminals(call: RuntimeCall, worktreeId: string): Promise<RuntimeTerminalSummary[]> {
  return call<{ terminals: RuntimeTerminalSummary[] }>('terminal.list', {
    worktree: `id:${worktreeId}`
  }).then((listed) => listed.terminals)
}

// oxlint-disable-next-line no-empty-pattern -- Owns both app launches; Playwright needs the fixtures argument.
test('a surviving printer in a never-opened workspace streams to main after relaunch', async ({}, testInfo) => {
  // Two full app launches with a quit between them.
  test.setTimeout(300_000)
  const session = createRestartSession(testInfo)
  const first = await launchWithUnopenedWorkspace(session)
  let app = first.app
  try {
    const { call, unopened } = first
    const { terminal } = await call<{ terminal: { handle: string } }>('terminal.create', {
      worktree: `id:${unopened}`,
      command: `node ${JSON.stringify(printerPath)}`,
      focus: false,
      activate: false,
      presentation: 'background'
    })
    await expect
      .poll(
        async () =>
          (
            await call<{ terminal: { tail: string[] } }>('terminal.read', {
              terminal: terminal.handle,
              limit: 20
            })
          ).terminal.tail.join('\n'),
        { timeout: 30_000 }
      )
      .toContain('tick ')
    const { ptyId } = (await listTerminals(call, unopened)).find(
      (t) => t.handle === terminal.handle
    )!

    await session.close(app)
    const second = await session.launch()
    app = second.app
    await waitForSessionReady(second.page)
    await waitForActiveWorktree(second.page)
    // Precondition: no window pane holds the printer, so only main can attach it.
    expect(
      await second.page.evaluate(
        (worktreeId) => window.__store!.getState().activeWorktreeId === worktreeId,
        unopened
      )
    ).toBe(false)
    const survivor = async (): Promise<RuntimeTerminalSummary | undefined> =>
      (await listTerminals(call, unopened)).find((terminal) => terminal.ptyId === ptyId)
    await expect.poll(async () => (await survivor())?.connected, { timeout: 60_000 }).toBe(true)
    const expectMainReceiving = async (message: string): Promise<void> => {
      let baseline: number | null = null
      await expect
        .poll(
          async () => {
            const lastOutputAt = (await survivor())?.lastOutputAt ?? null
            baseline ??= lastOutputAt
            return baseline !== null && lastOutputAt !== null && lastOutputAt > baseline
          },
          { timeout: 5_000, message }
        )
        .toBe(true)
    }
    await expectMainReceiving('main never received the surviving printer output')

    // A pane mounting later shares main's daemon client, so main keeps receiving.
    await expect
      .poll(
        () =>
          second.page.evaluate((worktreeId) => {
            let state = window.__store!.getState()
            if (state.activeWorktreeId !== worktreeId) {
              state.setActiveWorktree(worktreeId)
              return false
            }
            const tab = state.tabsByWorktree[worktreeId]?.[0]
            if (!tab) {
              return false
            }
            if (state.activeTabId !== tab.id) {
              state.setActiveTab(tab.id)
              state.setActiveTabType('terminal', worktreeId)
            }
            state = window.__store!.getState()
            return state.activeWorktreeId === worktreeId && state.activeTabId === tab.id
          }, unopened),
        { timeout: 30_000 }
      )
      .toBe(true)
    // The pane paints from its own attach; xterm draws on a canvas, so read its buffer.
    await expect
      .poll(
        () =>
          second.page.evaluate(() => {
            const state = window.__store!.getState()
            const buffer = window.__paneManagers?.get(state.activeTabId ?? '')?.getActivePane()
              ?.terminal.buffer.active
            const line = buffer?.getLine(Math.max(0, buffer.baseY + buffer.cursorY - 1))
            return line?.translateToString(true) ?? ''
          }),
        { timeout: 30_000 }
      )
      .toContain('tick ')
    await expectMainReceiving('main stopped receiving after the pane mounted')
  } finally {
    await session.dispose(app).catch(() => undefined)
  }
})
