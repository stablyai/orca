import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import type { RuntimeTerminalRead } from '../../src/shared/runtime-types'
import { toWebTerminalSurfaceTabId } from '../../src/shared/terminal-surface-id'
import { expect, test } from './helpers/orca-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import { launchPairedWebClient } from './helpers/paired-electron-client'
import { getTerminalContent, waitForActivePanePtyId } from './helpers/terminal'

const MIN_EXHAUSTED_ACK_BYTES = 400 * 1024
const scratch = mkdtempSync(path.join(os.tmpdir(), 'orca-headless-stalled-stream-'))
const fixturePath = path.join(scratch, 'headless-stalled-stream.mjs')

writeFileSync(
  fixturePath,
  [
    "process.stdout.write('HEADLESS_STALL_READY\\r\\n')",
    "process.stdin.setEncoding('utf8')",
    "let pending = ''",
    "process.stdin.on('data', (data) => {",
    '  pending += data',
    '  const commands = pending.split(/\\r\\n|\\r|\\n/)',
    '  pending = commands.pop() ?? ""',
    '  for (const input of commands) {',
    "    if (input === 'GO') {",
    "      for (let row = 0; row < 16_000; row += 1) process.stdout.write(`headless-${row}-${'x'.repeat(80)}\\r\\n`)",
    "      process.stdout.write('HEADLESS_FLOOD_COMPLETE\\r\\n')",
    '      continue',
    '    }',
    '    process.stdout.write(`LIVE:${input}\\r\\n`)',
    '  }',
    '})',
    'process.stdin.resume()'
  ].join('\n')
)

test.afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function fixtureCommand(): string {
  const command = [process.execPath, fixturePath]
  return process.platform === 'win32'
    ? command.map((value) => `"${value.replaceAll('"', '""')}"`).join(' ')
    : command.map(shellQuote).join(' ')
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

test('recovers an ACK-starved stream from an isolated headless Orca host @headful', async ({
  testRepoPath
}) => {
  test.setTimeout(180_000)
  const host = await launchHeadlessPairedRuntimeHost()
  const client = await launchPairedWebClient(host.app, host.offer, {
    waitForWorkspace: false
  }).catch(async (error) => {
    await host.dispose()
    throw error
  })
  let terminal: string | null = null
  try {
    await host.client.call('repo.add', { path: testRepoPath, kind: 'git' })
    try {
      await client.page.locator('[data-worktree-sidebar]').waitFor({
        state: 'visible',
        timeout: 30_000
      })
    } catch {
      const boot = await client.page.evaluate(() => ({
        bodyChildren: document.body?.children.length ?? 0,
        bodyTextLength: document.body?.innerText.length ?? 0,
        hasApi: Boolean(window.api),
        hasRoot: Boolean(document.querySelector('#root')),
        hasStore: Boolean(window.__store),
        readyState: document.readyState,
        title: document.title
      }))
      throw new Error(`Headless paired web client did not boot: ${JSON.stringify(boot)}`)
    }
    await expect
      .poll(
        () =>
          client.page.evaluate(() => {
            const worktrees = window.__store?.getState().allWorktrees() ?? []
            return worktrees[0]?.id ?? null
          }),
        { timeout: 30_000 }
      )
      .not.toBeNull()
    const worktreeId = await client.page.evaluate(
      () => window.__store?.getState().allWorktrees()[0]?.id ?? null
    )
    if (!worktreeId) {
      throw new Error('Headless paired client did not receive the host worktree')
    }
    const created = await callRuntime<{
      tab: { parentTabId: string; terminal: string | null }
    }>(client.page, 'session.tabs.createTerminal', {
      worktree: `id:${worktreeId}`,
      command: fixtureCommand(),
      activate: false,
      select: false,
      navigation: 'caller'
    })
    terminal = created.tab.terminal
    if (!terminal) {
      throw new Error('Headless paired host did not publish the fixture terminal')
    }
    const webTabId = toWebTerminalSurfaceTabId(created.tab.parentTabId)
    await client.page.evaluate((id) => window.__store?.getState().setActiveWorktree(id), worktreeId)
    const tab = client.page.locator(`[data-testid="sortable-tab"][data-tab-id="${webTabId}"]`)
    await expect(tab).toBeVisible({ timeout: 30_000 })
    await tab.click()
    const originalPtyId = await waitForActivePanePtyId(client.page, 30_000)
    await expect
      .poll(() => getTerminalContent(client.page), { timeout: 30_000 })
      .toContain('HEADLESS_STALL_READY')

    await client.page.evaluate((target) => {
      const gate = (
        window as typeof window & {
          __remoteTerminalMultiplexAckGate?: { hold: (terminals: string[]) => void }
        }
      ).__remoteTerminalMultiplexAckGate
      if (!gate) {
        throw new Error('Remote terminal multiplex ACK gate is unavailable')
      }
      gate.hold([target])
    }, terminal)
    const textarea = client.page.locator('.xterm-helper-textarea:visible').first()
    await textarea.focus()
    await client.page.keyboard.type('GO')
    await client.page.keyboard.press('Enter')
    await expect
      .poll(
        () =>
          client.page.evaluate(() => {
            const gate = (
              window as typeof window & {
                __remoteTerminalMultiplexAckGate?: {
                  snapshot: () => { heldAckChars: number }
                }
              }
            ).__remoteTerminalMultiplexAckGate
            return gate?.snapshot().heldAckChars ?? 0
          }),
        { timeout: 30_000 }
      )
      .toBeGreaterThan(MIN_EXHAUSTED_ACK_BYTES)
    await expect
      .poll(
        async () => {
          const result = await callRuntime<{ terminal: RuntimeTerminalRead }>(
            client.page,
            'terminal.read',
            { terminal }
          )
          return result.terminal.tail.join('\n')
        },
        { timeout: 30_000 }
      )
      .toContain('HEADLESS_FLOOD_COMPLETE')

    const marker = `HEADLESS_RECOVERED_${Date.now()}`
    await callRuntime(client.page, 'terminal.send', {
      terminal,
      text: marker,
      enter: true,
      client: { id: 'headless-stalled-stream-e2e', type: 'desktop' }
    })
    expect(await getTerminalContent(client.page)).not.toContain(marker)
    expect(
      await client.page.evaluate(
        ({ target }) => {
          const gate = (
            window as typeof window & {
              __remoteTerminalMultiplexAckGate?: {
                sendInput: (terminal: string, text: string) => number
              }
            }
          ).__remoteTerminalMultiplexAckGate
          return gate?.sendInput(target, '\r') ?? 0
        },
        { target: terminal }
      )
    ).toBe(1)
    await expect
      .poll(() => getTerminalContent(client.page), { timeout: 30_000 })
      .toContain(`LIVE:${marker}`)
    expect(await waitForActivePanePtyId(client.page, 30_000)).toBe(originalPtyId)
    await expect(tab).toHaveAttribute('data-active', 'true')
  } finally {
    await client.page
      .evaluate(() => {
        ;(
          window as typeof window & {
            __remoteTerminalMultiplexAckGate?: { release: () => void }
          }
        ).__remoteTerminalMultiplexAckGate?.release()
      })
      .catch(() => undefined)
    if (terminal) {
      await callRuntime(client.page, 'terminal.closeTab', { terminal }).catch(() => undefined)
    }
    await client.dispose()
    await host.dispose()
  }
})
