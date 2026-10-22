/**
 * A paired client must recover when a mirrored remote session exits cleanly
 * server-side and the workspace is reopened from the sidebar: the after-wake
 * terminal ensure (or an equivalent) must give the workspace a live surface
 * again. The reported failure (ephemeral VM workspace, exit then reopen) was
 * an empty workspace: no terminal, no agent, no error — only an app restart
 * recovered.
 *
 * Run:
 *   pnpm exec playwright test \
 *     tests/e2e/paired-remote-terminal-session-exit-reopen.spec.ts \
 *     --config tests/playwright.config.ts --project electron-headless --workers=1
 */
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { toWebTerminalSurfaceTabId } from '../../src/shared/terminal-surface-id'
import { expect, test } from './helpers/orca-app'
import {
  launchHeadlessPairedRuntimeHost,
  type HeadlessPairedRuntimeHost
} from './helpers/headless-paired-runtime-host'
import {
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import {
  createHostCliTerminal,
  createRetentionFixtureDirectory,
  readSink
} from './helpers/host-created-terminal-retention-oracle'

const scratch = createRetentionFixtureDirectory()

/** Like the retention fixture, but exits with code 0 on the line EXIT-NOW:
 * a clean server-side session exit, the reported incident's signature. */
const fixturePath = path.join(scratch, 'session-exit-reopen-terminal.mjs')
const sinkPath = path.join(scratch, 'session-exit-reopen-terminal.log')
writeFileSync(
  fixturePath,
  [
    "import { appendFileSync } from 'node:fs'",
    'const sink = process.argv[2]',
    'const record = (line) => appendFileSync(sink, `${line}\\n`)',
    'record(`READY:${process.pid}`)',
    'process.stdout.write(`READY:${process.pid}\\r\\n`)',
    "process.stdin.setEncoding('utf8')",
    "let pending = ''",
    "process.stdin.on('data', (data) => {",
    '  pending += data',
    '  const lines = pending.split(/\\r\\n|\\r|\\n/)',
    "  pending = lines.pop() ?? ''",
    '  for (const line of lines) {',
    '    if (line === `EXIT-NOW`) {',
    '      record(`EXIT:${process.pid}`)',
    '      process.stdout.write(`EXIT:${process.pid}\\r\\n`)',
    '      process.exit(0)',
    '    }',
    '    record(`LINE:${line}`)',
    '    process.stdout.write(`LINE:${line}\\r\\n`)',
    '  }',
    '})',
    'process.stdin.resume()'
  ].join('\n')
)

async function callRuntime<TResult>(
  client: PairedElectronClient,
  method: string,
  params: unknown
): Promise<TResult> {
  return client.page.evaluate<TResult, { environmentId: string; method: string; params: unknown }>(
    async ({ environmentId, method, params }) => {
      const response = await window.api.runtimeEnvironments.call({
        selector: environmentId,
        method,
        params,
        timeoutMs: 30_000
      })
      if (!response.ok) {
        throw new Error(`${response.error.code}: ${response.error.message}`)
      }
      return response.result
    },
    { environmentId: client.environmentId, method, params }
  )
}

async function waitForWorktree(host: HeadlessPairedRuntimeHost, repoId: string): Promise<string> {
  let worktreeId = ''
  await expect
    .poll(
      async () => {
        const listed = await host.client.call<{ worktrees: { id: string }[] }>('worktree.list', {
          repo: `id:${repoId}`
        })
        worktreeId = listed.result.worktrees[0]?.id ?? ''
        return worktreeId
      },
      { timeout: 30_000, message: 'Serve host never listed its folder workspace' }
    )
    .not.toBe('')
  return worktreeId
}

async function waitForClientWorktree(
  client: PairedElectronClient,
  worktreeId: string
): Promise<void> {
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
      { timeout: 60_000, message: 'Paired client never received the serve-host workspace' }
    )
    .toBe(true)
}

/** The user's action: click the workspace row in the sidebar. */
async function clickSidebarWorkspaceRow(
  client: PairedElectronClient,
  worktreeId: string
): Promise<void> {
  const row = client.page.locator(`[data-worktree-id="${worktreeId}"][role="option"]`)
  await row.waitFor({ state: 'visible', timeout: 30_000 })
  await row.click()
}

async function readClientWorkspaceState(
  client: PairedElectronClient,
  worktreeId: string
): Promise<{
  tabIds: string[]
  activeTabId: string | null
  renderableTabCount: number
  hasWorktreeRow: boolean
}> {
  return client.page.evaluate((id) => {
    const state = window.__store?.getState()
    const tabs = state?.tabsByWorktree[id] ?? []
    return {
      tabIds: tabs.map((tab) => tab.id),
      activeTabId: state?.activeTabIdByWorktree?.[id] ?? null,
      renderableTabCount: state?.reconcileWorktreeTabModel(id).renderableTabCount ?? 0,
      hasWorktreeRow: Object.hasOwn(state?.tabsByWorktree ?? {}, id)
    }
  }, worktreeId)
}

async function readHostTerminalCount(
  host: HeadlessPairedRuntimeHost,
  worktreeId: string
): Promise<number> {
  const listed = await host.client.call<{
    tabs: { parentTabId?: string; leafId?: string; type: string }[]
  }>('session.tabs.list', { worktree: `id:${worktreeId}` })
  return listed.result.tabs.filter((tab) => tab.type === 'terminal').length
}

test('gives a reopened workspace a live surface after its remote session exits cleanly', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(300_000)
  const host = await launchHeadlessPairedRuntimeHost({ pinnedServePort: true })
  let client: PairedElectronClient | null = null
  const pageErrors: string[] = []
  try {
    const added = await host.client.call<{ repo: { id: string } }>('repo.add', {
      path: testRepoPath,
      kind: 'folder'
    })
    const worktreeId = await waitForWorktree(host, added.result.repo.id)
    client = await launchPairedElectronClient(host.offer, testInfo, 'session-exit-reopen')
    client.page.on('pageerror', (error) => pageErrors.push(String(error)))
    await waitForClientWorktree(client, worktreeId)

    const created = await createHostCliTerminal(
      (method, params) => callRuntime(client!, method, params),
      worktreeId,
      fixturePath,
      sinkPath
    )
    const webTabId = toWebTerminalSurfaceTabId(created.tabId)

    // Open the workspace the way the user does: sidebar row click.
    await clickSidebarWorkspaceRow(client, worktreeId)
    const tab = client.page.locator(`[data-testid="sortable-tab"][data-tab-id="${webTabId}"]`)
    await expect(tab).toBeVisible({ timeout: 60_000 })
    await tab.click()
    await expect
      .poll(
        () =>
          client!.page.evaluate((id) => {
            const manager = window.__paneManagers?.get(id)
            const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
            return pane?.serializeAddon?.serialize?.() ?? ''
          }, webTabId),
        { timeout: 60_000 }
      )
      .toContain('READY:')

    // The clean exit: fixture exits 0, then the wrapping shell exits so the
    // pty and its daemon session end — the incident's signature.
    await callRuntime(client, 'terminal.send', {
      terminal: created.handle,
      text: 'EXIT-NOW',
      enter: true
    })
    await expect
      .poll(() => readSink(sinkPath), { timeout: 30_000, message: 'Fixture never exited' })
      .toContain('EXIT:')
    await callRuntime(client, 'terminal.send', {
      terminal: created.handle,
      text: 'exit',
      enter: true
    })
    await expect
      .poll(() => readHostTerminalCount(host, worktreeId), {
        timeout: 30_000,
        message: 'Host never dropped the exited terminal tab'
      })
      .toBe(0)
    await expect
      .poll(() => readClientWorkspaceState(client!, worktreeId).then((s) => s.tabIds.length), {
        timeout: 30_000,
        message: 'Client mirror never dropped the exited terminal tab'
      })
      .toBe(0)
    await client.page.waitForTimeout(2_000)

    // The reopen: the user clicks the workspace in the sidebar again.
    await clickSidebarWorkspaceRow(client, worktreeId)
    await client.page.waitForTimeout(45_000)

    const observed = await readClientWorkspaceState(client, worktreeId)
    const hostTerminals = await readHostTerminalCount(host, worktreeId)
    console.log(
      'REPRO OBSERVATION\n' +
        `client: ${JSON.stringify(observed, null, 2)}\n` +
        `host terminal count: ${hostTerminals}\n` +
        `pageErrors: ${JSON.stringify(pageErrors, null, 2)}`
    )

    // Recovery contract: the reopened workspace must hold a live surface
    // again — a host terminal the after-wake ensure created (or equivalent).
    expect(hostTerminals, 'Reopened workspace has no live host surface').toBeGreaterThan(0)
    expect(observed.tabIds.length, 'Reopened workspace renders no tabs').toBeGreaterThan(0)
    expect(pageErrors, 'Renderer errors during exit and reopen').toEqual([])
  } finally {
    await client?.dispose()
    await host.dispose()
  }
})
