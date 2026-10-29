// After a network outage, the open paired terminal must accept typing again without process restart or manual Reconnect.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { toWebTerminalSurfaceTabId } from '../../src/shared/terminal-surface-id'
import { decodePairingOffer, encodePairingOffer } from '../../src/shared/pairing'
import { quotePosixShell } from '../../src/shared/shell-argument-quoting'
import { expect, test } from './helpers/orca-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import { cleanupE2EDaemons } from './helpers/electron-process-shutdown'
import {
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import { startFreezableTcpProxy, type FreezableTcpProxy } from './helpers/freezable-tcp-proxy'

const scratch = mkdtempSync(path.join(os.tmpdir(), 'orca-paired-terminal-outage-'))
const fixturePath = path.join(scratch, 'outage-terminal.mjs')

writeFileSync(
  fixturePath,
  [
    "import { appendFileSync } from 'node:fs'",
    'const sink = process.argv[2]',
    "process.stdout.write('READY\\r\\n')",
    "process.stdin.setEncoding('utf8')",
    "let pending = ''",
    "process.stdin.on('data', (data) => {",
    '  pending += data',
    '  const lines = pending.split(/\\r\\n|\\r|\\n/)',
    "  pending = lines.pop() ?? ''",
    '  for (const line of lines) {',
    '    appendFileSync(sink, `${line}\\n`)',
    '    process.stdout.write(`LIVE:${line}\\r\\n`)',
    '  }',
    '})',
    'process.stdin.resume()'
  ].join('\n')
)

test.afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

function fixtureCommand(sinkPath: string): string {
  const command = [process.execPath, fixturePath, sinkPath]
  return process.platform === 'win32'
    ? `& ${command.map((value) => `"${value.replaceAll('"', '""')}"`).join(' ')}`
    : command.map(quotePosixShell).join(' ')
}

function readText(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf8')
  } catch {
    return ''
  }
}

async function callRuntime<TResult>(
  page: Page,
  environmentId: string,
  method: string,
  params: unknown
): Promise<TResult> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test-only RPC result shape.
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

type PaneProbe = { content: string; ptyId: string | null; recovery: string | null }

async function readPane(page: Page, webTabId: string): Promise<PaneProbe> {
  return page.evaluate((id) => {
    const manager = window.__paneManagers?.get(id)
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    return {
      content: pane?.serializeAddon?.serialize?.() ?? '',
      ptyId: pane?.container.dataset.ptyId ?? null,
      recovery: pane?.container.dataset.ptyRecoveryState ?? null
    }
  }, webTabId)
}

async function typeIntoPane(page: Page, webTabId: string, text: string): Promise<void> {
  await page.evaluate((id) => {
    const manager = window.__paneManagers?.get(id)
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    if (!pane) {
      throw new Error(`No pane mounted for ${id}`)
    }
    pane.terminal.focus()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: xterm always renders its helper textarea.
    const textarea = pane.container.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement
    textarea.focus()
  }, webTabId)
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
}

const OUTAGES = [
  { mode: 'silent', ms: 30_000, label: '30 s' },
  { mode: 'reset', ms: 30_000, label: '30 s' },
  // Why: outlasts the pane's ~3 min auto-recovery window, with no `online` event when it returns.
  { mode: 'silent', ms: 200_000, label: 'long' }
] as const

for (const { mode, ms, label } of OUTAGES) {
  test(`an open remote terminal answers typing again after a ${label} ${mode} network outage`, async ({
    testRepoPath
  }, testInfo) => {
    test.setTimeout(ms + 330_000)
    const host = await launchHeadlessPairedRuntimeHost()
    let client: PairedElectronClient | null = null
    let proxy: FreezableTcpProxy | null = null
    try {
      await host.client.call('repo.add', { path: testRepoPath, kind: 'git' })
      const decoded = decodePairingOffer(host.offer.pairingUrl)
      if (!('endpoint' in decoded)) {
        throw new Error('expected a direct pairing offer')
      }
      const endpoint = new URL(decoded.endpoint)
      proxy = await startFreezableTcpProxy(endpoint.hostname, Number(endpoint.port))
      endpoint.port = String(proxy.port)
      client = await launchPairedElectronClient(
        { pairingUrl: encodePairingOffer({ ...decoded, endpoint: endpoint.toString() }) },
        testInfo,
        `terminal ${mode} outage`
      )
      const page = client.page
      const environmentId = client.environmentId
      await expect
        .poll(() => page.evaluate(() => window.__store?.getState().allWorktrees()[0]?.id ?? null), {
          timeout: 60_000
        })
        .not.toBeNull()
      const worktreeId = await page.evaluate(() => window.__store!.getState().allWorktrees()[0]!.id)
      const sinkPath = path.join(scratch, `${mode}.log`)
      const created = await callRuntime<{ tab: { parentTabId: string; terminal: string | null } }>(
        page,
        environmentId,
        'session.tabs.createTerminal',
        {
          worktree: `id:${worktreeId}`,
          command: fixtureCommand(sinkPath),
          activate: false,
          select: false,
          navigation: 'caller'
        }
      )
      expect(created.tab.terminal).toBeTruthy()
      const webTabId = toWebTerminalSurfaceTabId(created.tab.parentTabId)
      await expect
        .poll(
          () =>
            page.evaluate(
              ({ worktreeId, webTabId }) =>
                (window.__store?.getState().tabsByWorktree[worktreeId] ?? []).some(
                  (tab) => tab.id === webTabId
                ),
              { worktreeId, webTabId }
            ),
          { timeout: 60_000 }
        )
        .toBe(true)
      await page.evaluate(
        ({ worktreeId, webTabId }) => {
          const state = window.__store!.getState()
          state.setActiveView('terminal')
          state.setActiveWorktree(worktreeId)
          state.setActiveTab(webTabId)
          state.setActiveTabType('terminal', worktreeId)
        },
        { worktreeId, webTabId }
      )
      await expect
        .poll(async () => (await readPane(page, webTabId)).content, { timeout: 60_000 })
        .toContain('READY')
      await typeIntoPane(page, webTabId, 'before')
      await expect
        .poll(async () => (await readPane(page, webTabId)).content, { timeout: 15_000 })
        .toContain('LIVE:before')
      const ptyBefore = (await readPane(page, webTabId)).ptyId

      proxy.cut(mode)
      await page.waitForTimeout(ms)
      proxy.restore()

      const marker = `after_${mode}_${Date.now()}`
      // Why retyped: typing during recovery may be dropped by design; the pane must answer once back.
      try {
        await expect
          .poll(
            async () => {
              if (!readText(sinkPath).includes(marker)) {
                await typeIntoPane(page, webTabId, marker)
              }
              return (await readPane(page, webTabId)).content
            },
            { timeout: 120_000, intervals: [5_000] }
          )
          .toContain(`LIVE:${marker}`)
      } catch (error) {
        const probe = await readPane(page, webTabId)
        const evidence = {
          ...probe,
          content: probe.content.slice(-600),
          ptyBefore,
          sink: readText(sinkPath),
          sharedControl: await page.evaluate(
            async (id) =>
              (await window.api.runtimeEnvironments.list()).find((entry) => entry.id === id) ??
              null,
            environmentId
          ),
          proxyEvents: proxy.events
        }
        console.log('[outage] evidence', JSON.stringify(evidence))
        await page.screenshot({ path: testInfo.outputPath('after-outage.png') })
        throw error
      }
      expect((await readPane(page, webTabId)).ptyId).toBe(ptyBefore)
    } finally {
      if (client) {
        await cleanupE2EDaemons(client.userDataDir).catch(() => undefined)
        await client.dispose()
      }
      await proxy?.close()
      await host.dispose()
    }
  })
}
