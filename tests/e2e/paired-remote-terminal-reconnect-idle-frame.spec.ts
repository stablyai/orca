/**
 * #26887: after the connection to a remote host drops and comes back, a pane running an idle
 * full-screen program must show the program's current frame, not the one it drew before the drop.
 * The program changes its frame while the client is away and then goes quiet, the way an agent
 * finishes its turn during a laptop sleep, so no later byte can heal the pane.
 *
 * Two hosts: one that can image the pane (the reconnect snapshot repaints it), and one forced to
 * answer every snapshot with `no-serializable-buffer`, where only a repaint by the program itself
 * can bring the pane up to date.
 *
 * Run:
 *   ORCA_BACKGROUND_LAUNCH=1 pnpm exec playwright test \
 *     tests/e2e/paired-remote-terminal-reconnect-idle-frame.spec.ts \
 *     --config tests/playwright.config.ts --project electron-headless --workers=1
 */
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

test.skip(process.platform === 'win32', 'The fixture drives a POSIX alt-screen TUI')

const scratch = mkdtempSync(path.join(os.tmpdir(), 'orca-paired-idle-frame-'))
const fixturePath = path.join(scratch, 'idle-frame-tui.mjs')

// Why Node: its tty repaints on SIGWINCH only when the size really changed, like Claude Code.
writeFileSync(
  fixturePath,
  [
    "import { appendFileSync, readFileSync } from 'node:fs'",
    'const [stateFile, sink] = process.argv.slice(2)',
    "let frame = 'START'",
    'const draw = (why) => {',
    // Full repaint: alt screen, clear, frame.
    '  process.stdout.write(`\\x1b[?1049h\\x1b[H\\x1b[2JFRAME:${frame}\\r\\n`)',
    '  appendFileSync(sink, `${why}:${frame}\\n`)',
    '}',
    "process.stdout.on('resize', () => draw('resize'))",
    'setInterval(() => {',
    '  let next = ""',
    '  try { next = readFileSync(stateFile, "utf8").trim() } catch { return }',
    '  if (next && next !== frame) {',
    '    frame = next',
    // Diff-only update, like a spinner tick: rewrite the frame text in place.
    '    process.stdout.write(`\\x1b[1;7H${frame}\\x1b[K`)',
    '    appendFileSync(sink, `diff:${frame}\\n`)',
    '  }',
    '}, 200)',
    "process.stdin.setEncoding('utf8')",
    "let pending = ''",
    "process.stdin.on('data', (data) => {",
    '  pending += data',
    '  const lines = pending.split(/\\r\\n|\\r|\\n/)',
    "  pending = lines.pop() ?? ''",
    '  for (const line of lines.filter(Boolean)) {',
    '    frame = line',
    "    draw('input')",
    '  }',
    '})',
    "draw('start')"
  ].join('\n')
)

test.afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

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

async function readPane(page: Page, webTabId: string): Promise<string> {
  return page.evaluate((id) => {
    const manager = window.__paneManagers?.get(id)
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    return pane?.serializeAddon?.serialize?.() ?? ''
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

const HOSTS = [
  { label: 'a host that can image the pane', env: {}, programRepaints: false },
  {
    label: 'a host that cannot image the pane',
    env: { ORCA_E2E_FORCE_REMOTE_TERMINAL_SNAPSHOT_UNAVAILABLE: '1' },
    // Why asserted: proves the frame came from the program's own repaint, not a host image.
    programRepaints: true
  }
] as const

for (const { label, env, programRepaints } of HOSTS) {
  test(`an idle full-screen program shows its current frame after a reconnect, on ${label}`, async ({
    testRepoPath
  }, testInfo) => {
    test.setTimeout(420_000)
    const host = await launchHeadlessPairedRuntimeHost({ extraEnv: env })
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
        `idle frame ${label}`
      )
      const page = client.page
      await expect
        .poll(() => page.evaluate(() => window.__store?.getState().allWorktrees()[0]?.id ?? null), {
          timeout: 60_000
        })
        .not.toBeNull()
      const worktreeId = await page.evaluate(() => window.__store!.getState().allWorktrees()[0]!.id)
      const stateFile = path.join(scratch, `${testInfo.testId}.state`)
      const sinkPath = path.join(scratch, `${testInfo.testId}.log`)
      const created = await callRuntime<{ tab: { parentTabId: string; terminal: string | null } }>(
        page,
        client.environmentId,
        'session.tabs.createTerminal',
        {
          worktree: `id:${worktreeId}`,
          command: [process.execPath, fixturePath, stateFile, sinkPath]
            .map(quotePosixShell)
            .join(' '),
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
      // Why retyped: the pane may still be settling its first attach when the first line is typed.
      await expect
        .poll(
          async () => {
            const mounted = await page.evaluate(
              (id) => window.__paneManagers?.has(id) ?? false,
              webTabId
            )
            if (mounted && !readText(sinkPath).includes('input:BEFORE')) {
              await typeIntoPane(page, webTabId, 'BEFORE')
            }
            return readPane(page, webTabId)
          },
          { timeout: 120_000, intervals: [5_000] }
        )
        .toContain('FRAME:BEFORE')

      proxy.cut('reset')
      // The program moves on while the client is away, then goes idle.
      writeFileSync(stateFile, 'AFTER\n')
      await expect.poll(() => readText(sinkPath), { timeout: 15_000 }).toContain('diff:AFTER')
      await page.waitForTimeout(5_000)
      proxy.restore()

      try {
        await expect
          .poll(() => readPane(page, webTabId), { timeout: 120_000, intervals: [2_000] })
          .toContain('FRAME:AFTER')
        if (programRepaints) {
          expect(readText(sinkPath)).toContain('resize:AFTER')
        }
      } catch (error) {
        console.log(
          '[idle-frame] evidence',
          JSON.stringify({
            pane: (await readPane(page, webTabId)).slice(-600),
            sink: readText(sinkPath),
            proxyEvents: proxy.events
          })
        )
        await page.screenshot({ path: testInfo.outputPath('after-reconnect.png') })
        throw error
      }
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
