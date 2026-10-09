/**
 * Paired remote server: a desktop client that opens a remote terminal after it has printed more
 * than a screen must be able to scroll back through that history (#20158).
 *
 * The host used to serialize desktop subscribe snapshots screen-only, so the client pane held the
 * last screenful and nothing above it. Orcad-backed SSH panes use the same subscribe path.
 *
 * Run:
 *   pnpm exec playwright test \
 *     tests/e2e/paired-remote-terminal-initial-snapshot-scrollback.spec.ts \
 *     --config tests/playwright.config.ts --project electron-headless --workers=1
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient
} from './helpers/paired-electron-client'
import {
  callEnvironment,
  createPairedHostTerminal,
  openPairedClientTab,
  readPairedPaneContent,
  waitForPairedPaneMarker
} from './helpers/paired-host-terminal'

const LINE_COUNT = 300
const scratch = mkdtempSync(path.join(os.tmpdir(), 'orca-initial-scrollback-'))
const fixturePath = path.join(scratch, 'history-terminal.mjs')
writeFileSync(
  fixturePath,
  [
    `for (let i = 1; i <= ${LINE_COUNT}; i += 1) {`,
    "  process.stdout.write(`HIST-${String(i).padStart(4, '0')}\\r\\n`)",
    '}',
    "process.stdout.write('HISTORY_DONE\\r\\n')",
    'setInterval(() => {}, 1 << 30)'
  ].join('\n')
)

test.afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

function fixtureCommand(): string {
  const command = [process.execPath, fixturePath]
  return process.platform === 'win32'
    ? command.map((value) => `"${value.replaceAll('"', '""')}"`).join(' ')
    : command.map((value) => `'${value.replaceAll("'", `'\\''`)}'`).join(' ')
}

test('a desktop client opening a remote terminal receives its scrollback, not just the screen', async ({
  orcaPage
}, testInfo) => {
  test.setTimeout(300_000)
  const worktreeId = await orcaPage.evaluate(() => {
    const id = window.__store?.getState().activeWorktreeId
    if (!id) {
      throw new Error('host has no active worktree')
    }
    return id
  })
  const offer = await createRuntimeDesktopPairingOffer(orcaPage)
  const client = await launchPairedElectronClient(offer, testInfo, 'initial-scrollback')
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
                .some((worktree) => worktree.id === id) ?? false,
            worktreeId
          ),
        { timeout: 60_000, message: 'paired client never saw the host worktree' }
      )
      .toBe(true)
    const target = await createPairedHostTerminal(
      client.page,
      client.environmentId,
      worktreeId,
      fixtureCommand()
    )
    terminal = target.terminal
    // Let the host print everything before the client subscribes, so only the snapshot can carry it.
    await expect
      .poll(
        async () => {
          const read = await callEnvironment(client.page, client.environmentId, 'terminal.read', {
            terminal: target.terminal
          })
          return JSON.stringify(read).includes('HISTORY_DONE')
        },
        { timeout: 60_000, message: 'host terminal never finished printing' }
      )
      .toBe(true)
    await openPairedClientTab(client.page, worktreeId, target.webTabId)
    expect(
      await waitForPairedPaneMarker(client.page, target.webTabId, 'HISTORY_DONE', 30_000)
    ).toBe(true)
    const content = await readPairedPaneContent(client.page, target.webTabId)
    const firstLine = content.split(/\r?\n/).find((line) => line.startsWith('HIST-'))
    console.log(`[initial-scrollback] first history line on client: ${firstLine ?? '(none)'}`)
    expect(content).toContain('HIST-0001')
  } finally {
    if (terminal) {
      await callEnvironment(client.page, client.environmentId, 'terminal.closeTab', {
        terminal
      }).catch(() => undefined)
    }
    await client.dispose()
  }
})
