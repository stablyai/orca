import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import type {
  RuntimeTerminalListResult,
  RuntimeTerminalRead,
  RuntimeTerminalShow
} from '../../src/shared/runtime-types'
import { toWebTerminalSurfaceTabId } from '../../src/shared/terminal-surface-id'
import { expect, test } from './helpers/orca-app'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedWebClient
} from './helpers/paired-electron-client'
import { getTerminalContent, waitForActivePanePtyId } from './helpers/terminal'

const scratch = mkdtempSync(path.join(os.tmpdir(), 'orca-paired-probe-gap-'))
const fixturePath = path.join(scratch, 'probe-gap-terminal.mjs')
const processedInputPath = path.join(scratch, 'processed-input.txt')
writeFileSync(processedInputPath, '')
writeFileSync(
  fixturePath,
  [
    "import { appendFileSync } from 'node:fs'",
    'const processedInputPath = process.argv[2]',
    "process.stdout.write('PROBE_GAP_READY\\r\\n')",
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

test('replaces a stale paired stream when the PTY snapshot advanced @headful', async ({
  electronApp,
  orcaPage
}) => {
  test.setTimeout(90_000)
  const worktreeId = await orcaPage.evaluate(() => {
    const state = window.__store?.getState()
    const id = state?.activeWorktreeId
    if (!id || !state?.allWorktrees().some((candidate) => candidate.id === id)) {
      throw new Error('Headed host did not select its seeded worktree')
    }
    return id
  })
  const offer = await createRuntimeDesktopPairingOffer(orcaPage)
  const client = await launchPairedWebClient(electronApp, offer)
  let terminal: string | null = null
  try {
    await expect
      .poll(
        () =>
          client.page.evaluate(
            (id) =>
              window.__store
                ?.getState()
                .allWorktrees()
                .some((candidate) => candidate.id === id),
            worktreeId
          ),
        { timeout: 30_000 }
      )
      .toBe(true)
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
      throw new Error('Paired runtime did not publish the probe-gap fixture')
    }
    const webTabId = toWebTerminalSurfaceTabId(created.tab.parentTabId)
    await client.page.evaluate((id) => window.__store?.getState().setActiveWorktree(id), worktreeId)
    const tab = client.page.locator(`[data-testid="sortable-tab"][data-tab-id="${webTabId}"]`)
    await expect(tab).toBeVisible({ timeout: 30_000 })
    await tab.click()
    await expect(tab).toHaveAttribute('data-active', 'true')
    const originalPtyId = await waitForActivePanePtyId(client.page, 30_000)
    const originalHostTerminal = await callRuntime<{ terminal: RuntimeTerminalShow }>(
      orcaPage,
      'terminal.show',
      { terminal }
    )
    expect(originalHostTerminal.terminal.ptyId).not.toBeNull()
    await expect
      .poll(() => getTerminalContent(client.page), { timeout: 30_000 })
      .toContain('PROBE_GAP_READY')
    const textarea = client.page.locator('.xterm-helper-textarea:visible').first()
    await textarea.focus()

    expect(
      await client.page.evaluate((target) => {
        const gate = (
          window as typeof window & {
            __remoteTerminalMultiplexAckGate?: {
              dropOutputUntilResubscribe: (terminals: string[]) => number
            }
          }
        ).__remoteTerminalMultiplexAckGate
        if (!gate) {
          throw new Error('Remote terminal multiplex output gate is unavailable')
        }
        return gate.dropOutputUntilResubscribe([target])
      }, terminal)
    ).toBe(1)
    const missingMarker = `PROBE_GAP_MISSING_${Date.now()}`
    await client.page.keyboard.type(missingMarker)
    await client.page.keyboard.press('Enter')

    await expect
      .poll(
        () =>
          client.page.evaluate(() => {
            const gate = (
              window as typeof window & {
                __remoteTerminalMultiplexAckGate?: {
                  snapshot: () => { droppedOutputFrames: number }
                }
              }
            ).__remoteTerminalMultiplexAckGate
            return gate?.snapshot().droppedOutputFrames ?? 0
          }),
        { timeout: 10_000 }
      )
      .toBeGreaterThan(0)
    await expect
      .poll(() => readFileSync(processedInputPath, 'utf8'), { timeout: 10_000 })
      .toContain(`${missingMarker}\n`)
    await expect
      .poll(
        async () => {
          const result = await callRuntime<{ terminal: RuntimeTerminalRead }>(
            orcaPage,
            'terminal.read',
            { terminal }
          )
          return result.terminal.tail.join('\n')
        },
        { timeout: 10_000 }
      )
      .toContain(missingMarker)
    expect(await getTerminalContent(client.page)).not.toContain(`LIVE:${missingMarker}`)

    await expect
      .poll(() => getTerminalContent(client.page), { timeout: 20_000 })
      .toContain(`LIVE:${missingMarker}`)
    await expect(tab).toHaveAttribute('data-active', 'true')
    expect(await waitForActivePanePtyId(client.page, 30_000)).toBe(originalPtyId)
    const recoveredHostTerminal = await callRuntime<{ terminal: RuntimeTerminalShow }>(
      orcaPage,
      'terminal.show',
      { terminal }
    )
    expect(recoveredHostTerminal.terminal.ptyId).toBe(originalHostTerminal.terminal.ptyId)
    const hostTerminals = await callRuntime<RuntimeTerminalListResult>(orcaPage, 'terminal.list', {
      worktree: `id:${worktreeId}`,
      requireFreshPtyLiveness: true
    })
    expect(
      hostTerminals.terminals
        .filter((candidate) => candidate.tabId === created.tab.parentTabId)
        .map((candidate) => ({ handle: candidate.handle, ptyId: candidate.ptyId }))
    ).toEqual([{ handle: terminal, ptyId: originalHostTerminal.terminal.ptyId }])

    const liveMarker = `PROBE_GAP_LIVE_${Date.now()}`
    await textarea.focus()
    await client.page.keyboard.type(liveMarker)
    await client.page.keyboard.press('Enter')
    await expect
      .poll(() => getTerminalContent(client.page), { timeout: 10_000 })
      .toContain(`LIVE:${liveMarker}`)
    await expect
      .poll(() => readFileSync(processedInputPath, 'utf8'), { timeout: 10_000 })
      .toContain(`${liveMarker}\n`)
    expect(await waitForActivePanePtyId(client.page, 30_000)).toBe(originalPtyId)
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
      await callRuntime(orcaPage, 'terminal.closeTab', { terminal }).catch(() => undefined)
    }
    await client.dispose()
  }
})
