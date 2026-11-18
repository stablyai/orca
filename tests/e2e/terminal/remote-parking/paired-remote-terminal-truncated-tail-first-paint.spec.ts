import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import type { RuntimeTerminalRead } from '../../../../src/shared/terminal/runtime/runtime-terminal-contracts'
import '../../../../src/shared/remote-runtime/protocol/protocol-version'
import '../../../../src/shared/terminal/runtime-policy/terminal-runtime-capabilities'

import { toWebTerminalSurfaceTabId } from '../../../../src/shared/workspace-layout/terminal-surface-id'
import { test } from '../../desktop/electron-fixtures/orca-app'
import { expect } from '@stablyai/playwright-test'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedWebClient
} from '../../remote/paired-runtime/client-hosts/paired-electron-client'
import { waitForActivePanePtyId } from '../input/terminal'
import { getTerminalContent } from '../layout/terminal-pane-identity'
import { quotePosixShell } from '../../../../src/shared/shell/launch/shell-argument-quoting'

const RETENTION_PARK_DELAY_MS = 100
const scratch = mkdtempSync(path.join(os.tmpdir(), 'orca-paired-truncated-tail-'))
const fixturePath = path.join(scratch, 'truncated-tail-terminal.mjs')
writeFileSync(
  fixturePath,
  [
    'const marker = process.argv[2]',
    'let flooded = false',
    "process.stdout.write('REMOTE_TRUNCATED_TAIL_READY\\r\\n')",
    "process.stdin.setEncoding('utf8')",
    "process.stdin.on('data', (data) => {",
    "  if (!flooded && data.includes('GO')) {",
    '    flooded = true',
    "    for (let row = 0; row < 4_000; row += 1) process.stdout.write(`overflow-${row}-${'x'.repeat(80)}\\r\\n`)",
    '    process.stdout.write(`${marker}\\r\\n`)',
    '    return',
    '  }',
    '  process.stdout.write(`LIVE:${data.trim()}\\r\\n`)',
    '})',
    'process.stdin.resume()'
  ].join('\n')
)

test.afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

test.use({
  orcaAppExtraEnv: {
    ORCA_E2E_TERMINAL_PARKING_DELAY_MS: String(RETENTION_PARK_DELAY_MS),
    ORCA_E2E_TERMINAL_RETENTION_LIMIT: '1'
  }
})

function fixtureCommand(marker: string): string {
  const command = [process.execPath, fixturePath, marker]
  return process.platform === 'win32'
    ? command.map((value) => `"${value.replaceAll('"', '""')}"`).join(' ')
    : command.map(quotePosixShell).join(' ')
}

async function callRuntime<TResult>(page: Page, method: string, params: unknown): Promise<TResult> {
  return page.evaluate(
    async ({ method, params }) => {
      const response = await window.api.runtime.call({ method, params })
      if (!response.ok) {
        throw new Error(`${response.error.code}: ${response.error.message}`)
      }
      return response.result
    },
    { method, params }
  ) as Promise<TResult>
}

test('paints a paired remote terminal when only its retained text tail overflowed @headful', async ({
  electronApp,
  orcaPage
}) => {
  test.setTimeout(120_000)
  const firstPaintMarker = `REMOTE_TRUNCATED_TAIL_FIRST_PAINT_${Date.now()}`
  const liveMarker = `REMOTE_TRUNCATED_TAIL_LIVE_${Date.now()}`
  const worktree = await orcaPage.evaluate(() => {
    const state = window.__store?.getState()
    const activeWorktreeId = state?.activeWorktreeId
    if (!activeWorktreeId) {
      throw new Error('Headed host did not select its seeded worktree')
    }
    const activeWorktree = state
      .allWorktrees()
      .find((candidate) => candidate.id === activeWorktreeId)
    if (!activeWorktree) {
      throw new Error('Headed host active worktree was absent from inventory')
    }
    return { id: activeWorktree.id, path: activeWorktree.path }
  })
  const offer = await createRuntimeDesktopPairingOffer(orcaPage)
  const client = await launchPairedWebClient(electronApp, offer)
  let terminal: string | null = null
  try {
    await expect
      .poll(
        () =>
          client.page.evaluate(
            (worktreeId) =>
              window.__store
                ?.getState()
                .allWorktrees()
                .some((candidate) => candidate.id === worktreeId),
            worktree.id
          ),
        { timeout: 30_000 }
      )
      .toBe(true)
    const created = await callRuntime<{
      tab: {
        parentTabId: string
        leafId: string
        terminal: string | null
      }
    }>(client.page, 'session.tabs.createTerminal', {
      worktree: `id:${worktree.id}`,
      command: fixtureCommand(firstPaintMarker),
      activate: false,
      select: false,
      navigation: 'caller'
    })
    terminal = created.tab.terminal
    if (!terminal) {
      throw new Error('Paired runtime did not publish the overflow fixture terminal')
    }

    const webTabId = toWebTerminalSurfaceTabId(created.tab.parentTabId)
    await expect
      .poll(
        () =>
          client.page.evaluate(
            ({ tabId, worktreeId }) =>
              (window.__store?.getState().tabsByWorktree[worktreeId] ?? []).some(
                (tab) => tab.id === tabId
              ),
            { tabId: webTabId, worktreeId: worktree.id }
          ),
        { timeout: 30_000 }
      )
      .toBe(true)
    await client.page.evaluate(
      (worktreeId) => window.__store?.getState().setActiveWorktree(worktreeId),
      worktree.id
    )
    const remoteTab = client.page.locator(`[data-testid="sortable-tab"][data-tab-id="${webTabId}"]`)
    await expect(remoteTab).toBeVisible({ timeout: 30_000 })
    await remoteTab.click()
    await expect(remoteTab).toHaveAttribute('data-active', 'true')
    await waitForActivePanePtyId(client.page, 30_000)
    await expect
      .poll(() => getTerminalContent(client.page), { timeout: 30_000 })
      .toContain('REMOTE_TRUNCATED_TAIL_READY')
    await callRuntime(client.page, 'terminal.send', {
      terminal,
      text: 'WARMUP',
      enter: true,
      client: { id: 'paired-truncated-tail-e2e', type: 'desktop' }
    })
    await expect
      .poll(() => getTerminalContent(client.page), { timeout: 30_000 })
      .toContain('LIVE:WARMUP')
    await callRuntime(client.page, 'terminal.send', {
      terminal,
      text: 'GO',
      enter: true,
      client: { id: 'paired-truncated-tail-e2e', type: 'desktop' }
    })
    await expect
      .poll(() => getTerminalContent(client.page), { timeout: 30_000 })
      .toContain(firstPaintMarker)
    await expect
      .poll(
        async () => {
          const result = await callRuntime<{ terminal: RuntimeTerminalRead }>(
            client.page,
            'terminal.read',
            { terminal }
          )
          return {
            marker: result.terminal.tail.join('\n').includes(firstPaintMarker),
            truncated: result.terminal.truncated
          }
        },
        { timeout: 30_000 }
      )
      .toEqual({ marker: true, truncated: true })

    await client.page.reload()
    await client.page.locator('[data-worktree-sidebar]').waitFor({
      state: 'visible',
      timeout: 30_000
    })
    await client.page.evaluate(
      (worktreeId) => window.__store?.getState().setActiveWorktree(worktreeId),
      worktree.id
    )
    const restoredRemoteTab = client.page.locator(
      `[data-testid="sortable-tab"][data-tab-id="${webTabId}"]`
    )
    await expect(restoredRemoteTab).toBeVisible({ timeout: 30_000 })
    await restoredRemoteTab.click()
    await expect(restoredRemoteTab).toHaveAttribute('data-active', 'true')
    await expect
      .poll(() => getTerminalContent(client.page), { timeout: 30_000 })
      .toContain(firstPaintMarker)

    await callRuntime(client.page, 'terminal.send', {
      terminal,
      text: liveMarker,
      enter: true,
      client: { id: 'paired-truncated-tail-e2e', type: 'desktop' }
    })
    await expect
      .poll(() => getTerminalContent(client.page), { timeout: 30_000 })
      .toContain(`LIVE:${liveMarker}`)
  } finally {
    if (terminal) {
      await callRuntime(client.page, 'terminal.closeTab', { terminal }).catch(() => undefined)
    }
    await client.dispose()
  }
})
