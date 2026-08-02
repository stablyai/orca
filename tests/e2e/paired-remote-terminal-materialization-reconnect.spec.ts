import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeTerminalListResult,
  RuntimeTerminalRead,
  RuntimeTerminalShow
} from '../../src/shared/runtime-types'
import { toWebTerminalSurfaceTabId } from '../../src/shared/terminal-surface-id'
import { expect, test } from './helpers/orca-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient
} from './helpers/paired-electron-client'
import { getTerminalContent, waitForActivePanePtyId } from './helpers/terminal'

const scratch = mkdtempSync(path.join(os.tmpdir(), 'orca-paired-materialize-'))
const fixturePath = path.join(scratch, 'materialize-terminal.mjs')
const processedInputPath = path.join(scratch, 'processed-input.txt')

writeFileSync(
  fixturePath,
  [
    "import { appendFileSync } from 'node:fs'",
    'const processedInputPath = process.argv[2]',
    "process.stdout.write('MATERIALIZE_READY\\r\\n')",
    "process.stdin.setEncoding('utf8')",
    "let pending = ''",
    "process.stdin.on('data', (data) => {",
    '  pending += data',
    '  const commands = pending.split(/\\r\\n|\\r|\\n/)',
    '  pending = commands.pop() ?? ""',
    '  for (const input of commands) {',
    '    appendFileSync(processedInputPath, `${input}\\n`)',
    '    process.stdout.write(`LIVE:${input}\\r\\n`)',
    '  }',
    '})',
    'process.stdin.resume()'
  ].join('\n')
)

test.describe.configure({ mode: 'serial' })

test.afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function fixtureCommand(): string {
  const command = [process.execPath, fixturePath, processedInputPath]
  return process.platform === 'win32'
    ? command.map((value) => `"${value.replaceAll('"', '""')}"`).join(' ')
    : command.map(shellQuote).join(' ')
}

async function callRuntime<TResult>(
  page: Page,
  selector: string,
  method: string,
  params: unknown
): Promise<TResult> {
  return page.evaluate(
    async ({ method, params, selector }) => {
      const response = await window.api.runtimeEnvironments.call({ selector, method, params })
      if (!response.ok) {
        throw new Error(`${response.error.code}: ${response.error.message}`)
      }
      return response.result
    },
    { method, params, selector }
  ) as Promise<TResult>
}

async function showClient(app: ElectronApplication, page: Page): Promise<void> {
  const clientWindow = await app.browserWindow(page)
  await clientWindow.evaluate((window) => {
    window.show()
    window.focus()
  })
  await expect.poll(() => clientWindow.evaluate((window) => window.isVisible())).toBe(true)
}

async function waitForClientWorktree(page: Page, expectedId?: string): Promise<string> {
  await expect
    .poll(
      () =>
        page.evaluate(
          (id) =>
            window.__store
              ?.getState()
              .allWorktrees()
              .find((worktree) => !id || worktree.id === id)?.id ?? null,
          expectedId
        ),
      { timeout: 30_000 }
    )
    .not.toBeNull()
  const worktreeId = await page.evaluate(
    (id) =>
      window.__store
        ?.getState()
        .allWorktrees()
        .find((worktree) => !id || worktree.id === id)?.id ?? null,
    expectedId
  )
  if (!worktreeId) {
    throw new Error('Paired client did not receive the host workspace')
  }
  return worktreeId
}

async function runMaterializationJourney(
  page: Page,
  environmentId: string,
  worktreeId: string
): Promise<void> {
  writeFileSync(processedInputPath, '')
  const created = await callRuntime<{
    tab: { parentTabId: string; terminal: string | null }
  }>(page, environmentId, 'session.tabs.createTerminal', {
    worktree: `id:${worktreeId}`,
    command: fixtureCommand(),
    activate: false,
    select: false,
    navigation: 'caller'
  })
  const originalHandle = created.tab.terminal
  if (!originalHandle) {
    throw new Error('Host did not publish the fixture terminal')
  }

  const webTabId = toWebTerminalSurfaceTabId(created.tab.parentTabId)
  await page.evaluate((id) => window.__store?.getState().setActiveWorktree(id), worktreeId)
  const tab = page.locator(`[data-testid="sortable-tab"][data-tab-id="${webTabId}"]`)
  await expect(tab).toBeVisible({ timeout: 30_000 })
  await tab.click()
  await expect(tab).toHaveAttribute('data-active', 'true')
  const originalClientPtyId = await waitForActivePanePtyId(page, 30_000)
  await expect
    .poll(() => getTerminalContent(page), { timeout: 30_000 })
    .toContain('MATERIALIZE_READY')

  const originalTerminal = await callRuntime<{ terminal: RuntimeTerminalShow }>(
    page,
    environmentId,
    'terminal.show',
    { terminal: originalHandle }
  )
  if (!originalTerminal.terminal.ptyId) {
    throw new Error('Host fixture terminal has no authoritative PTY')
  }
  await page.evaluate((terminal) => {
    const gate = (
      window as typeof window & {
        __remoteTerminalMultiplexAckGate?: { holdEnd: (terminals: string[]) => void }
      }
    ).__remoteTerminalMultiplexAckGate
    if (!gate) {
      throw new Error('Remote terminal fault gate is unavailable')
    }
    gate.holdEnd([terminal])
  }, originalHandle)
  const stop = await callRuntime<{
    stopped: number
    stoppedPtyIds: string[]
    postStopVerified: boolean
  }>(page, environmentId, 'terminal.stopExact', {
    worktree: `id:${worktreeId}`,
    expectedPtyIds: [originalTerminal.terminal.ptyId],
    keepHistory: true,
    targetOnly: true
  })
  expect(stop.postStopVerified).toBe(true)
  expect(stop.stopped).toBe(1)
  expect(stop.stoppedPtyIds).toEqual([originalTerminal.terminal.ptyId])
  const dispatched = await page.evaluate((terminal) => {
    const gate = (
      window as typeof window & {
        __remoteTerminalMultiplexAckGate?: {
          forceError: (terminals: string[], message: string) => number
          release: () => void
        }
      }
    ).__remoteTerminalMultiplexAckGate
    if (!gate) {
      throw new Error('Remote terminal fault gate is unavailable')
    }
    const dispatched = gate.forceError([terminal], 'terminal_handle_stale')
    gate.release()
    return dispatched
  }, originalHandle)
  expect(dispatched).toBe(1)

  let replacementHandle: string | null = null
  await expect
    .poll(
      async () => {
        const snapshot = await callRuntime<RuntimeMobileSessionTabsResult>(
          page,
          environmentId,
          'session.tabs.list',
          { worktree: `id:${worktreeId}` }
        )
        const surface = snapshot.tabs.find(
          (candidate) =>
            candidate.type === 'terminal' && candidate.parentTabId === created.tab.parentTabId
        )
        replacementHandle = surface?.type === 'terminal' ? surface.terminal : null
        return replacementHandle !== null && replacementHandle !== originalHandle
      },
      { timeout: 20_000, message: 'Reconnect never materialized the sleeping host surface' }
    )
    .toBe(true)
  expect(replacementHandle).not.toBeNull()

  const replacementClientPtyId = await waitForActivePanePtyId(page, 20_000)
  expect(replacementClientPtyId).not.toBe(originalClientPtyId)

  const marker = `MATERIALIZED_${Date.now()}`
  await callRuntime(page, environmentId, 'terminal.send', {
    terminal: replacementHandle,
    text: `echo ${marker}\r`,
    client: { id: 'paired-materialization-e2e', type: 'desktop' }
  })
  await expect
    .poll(
      async () => {
        const read = await callRuntime<{ terminal: RuntimeTerminalRead }>(
          page,
          environmentId,
          'terminal.read',
          { terminal: replacementHandle }
        )
        return read.terminal.tail.join('\n')
      },
      { timeout: 10_000 }
    )
    .toContain(marker)
  await page.evaluate(async (id) => {
    await window.__store?.getState().setActiveWorktree(id)
  }, worktreeId)
  await expect(tab).toBeVisible({ timeout: 10_000 })
  await tab.click()
  await expect.poll(() => getTerminalContent(page), { timeout: 10_000 }).toContain(marker)

  const listed = await callRuntime<RuntimeTerminalListResult>(
    page,
    environmentId,
    'terminal.list',
    {
      worktree: `id:${worktreeId}`,
      requireFreshPtyLiveness: true
    }
  )
  expect(
    listed.terminals.filter((terminal) => terminal.tabId === created.tab.parentTabId)
  ).toHaveLength(1)
  await callRuntime(page, environmentId, 'terminal.closeTab', { terminal: replacementHandle })
}

test('materializes a stopped terminal on reconnect from a headed paired host @headful', async ({
  orcaPage
}, testInfo) => {
  test.setTimeout(120_000)
  const worktreeId = await orcaPage.evaluate(() => window.__store?.getState().activeWorktreeId)
  if (!worktreeId) {
    throw new Error('Headed host has no active seeded workspace')
  }
  const offer = await createRuntimeDesktopPairingOffer(orcaPage)
  const client = await launchPairedElectronClient(offer, testInfo, 'headed-materialization-client')
  try {
    await showClient(client.app, client.page)
    await runMaterializationJourney(
      client.page,
      client.environmentId,
      await waitForClientWorktree(client.page, worktreeId)
    )
    expect(await client.getDirectSshAttemptTargetIds()).toEqual([])
  } finally {
    await client.dispose()
  }
})

test('materializes a stopped terminal on reconnect from a headless folder host @headful', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(150_000)
  const host = await launchHeadlessPairedRuntimeHost()
  await host.client.call('repo.add', { path: testRepoPath, kind: 'folder' })
  const client = await launchPairedElectronClient(
    host.offer,
    testInfo,
    'headless-folder-materialization-client'
  ).catch(async (error) => {
    await host.dispose()
    throw error
  })
  try {
    await showClient(client.app, client.page)
    await runMaterializationJourney(
      client.page,
      client.environmentId,
      await waitForClientWorktree(client.page)
    )
    expect(await client.getDirectSshAttemptTargetIds()).toEqual([])
  } finally {
    await client.dispose()
    await host.dispose()
  }
})
