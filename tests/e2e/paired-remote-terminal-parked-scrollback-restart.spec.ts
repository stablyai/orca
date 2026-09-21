/**
 * Does a parked remote pane's scrollback survive a full client restart?
 *
 * The within-session case is covered by paired-remote-terminal-parked-scrollback-survives.spec.ts.
 * This restarts the client on the SAME profile — the shape of an app update — and reports, hop by
 * hop, where the park capture lands.
 *
 * The load-bearing oracle is ON DISK, not the reveal. The paired host's pty stays alive across the
 * client restart and keeps a retained tail (terminal-multiplex-initial-snapshot:
 * `data: serialized?.data ?? read.tail…`), so a reveal can be served by the host rather than by the
 * client's persisted copy — it is kept as an end-to-end check, not the proof. The contradiction-
 * capable signal for this fix is which partition on disk holds the buffer after a debounced write.
 *
 * Two quits, because they exercise different writers:
 *   - clean quit: the beforeunload checkpoint writes a full per-partition snapshot, which carries
 *     tabsByWorktree and so routes the layout correctly even on `main` — a control that the harness
 *     works, not a proof of this fix.
 *   - hard kill: only the debounced patch writer ran. A park capture's patch changes only
 *     terminalLayoutsByTabId, so it carries no tab rows; before the fix every layout fell into the
 *     'local' partition, where main strips scrollback it cannot attribute to a remote worktree, and
 *     the remote host's partition never received the capture (#21295). This is the test that fails
 *     with the fix reverted.
 *
 * The on-disk reader walks the local `workspaceSession` AND every `workspaceSessionsByHostId`
 * partition, and names the partition each reading came from — the issue's original "onDisk: 0" was a
 * reader that inspected only the local blob while the capture sat in the runtime partition, a
 * reading that could not contradict itself. An empty list means no session file at all (a deleted
 * profile), distinguished from an empty buffer.
 *
 * Run:
 *   pnpm exec playwright test \
 *     tests/e2e/paired-remote-terminal-parked-scrollback-restart.spec.ts \
 *     --config tests/playwright.config.ts --project electron-headless --workers=1
 */
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import type { Page, TestInfo } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { resolveLeafScrollbackBuffers } from '../../src/renderer/src/components/terminal-pane/leaf-scrollback-resolution'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import { cleanupE2EDaemons, forceQuitElectronAppForE2E } from './helpers/electron-process-shutdown'
import {
  callEnvironment,
  createPairedHostTerminal,
  openPairedClientTab,
  waitForPairedPaneMarker
} from './helpers/paired-host-terminal'
import { focusActiveTerminalInput } from './helpers/terminal'
import { waitForTabParked } from './helpers/terminal-hidden-parking'

const PARK_DELAY_MS = 2_000
const PAINT_BUDGET_MS = 30_000
/** Renderer debounce (150 ms) + main's save debounce (1 s, 5 s max wait), with slack. */
const DEBOUNCED_WRITE_BUDGET_MS = 20_000
const scratch = mkdtempSync(path.join(os.tmpdir(), 'orca-parked-restart-'))
const fixturePath = path.join(scratch, 'echo-terminal.mjs')
writeFileSync(
  fixturePath,
  [
    "process.stdout.write('READY\\r\\n')",
    "process.stdin.setEncoding('utf8')",
    "let pending = ''",
    "process.stdin.on('data', (data) => {",
    '  pending += data',
    '  const lines = pending.split(/\\r\\n|\\r|\\n/)',
    "  pending = lines.pop() ?? ''",
    '  for (const line of lines) {',
    '    process.stdout.write(`LINE:${line}\\r\\n`)',
    '  }',
    '})',
    'process.stdin.resume()'
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

type OnDiskPartitionReading = {
  partition: string
  hasTabRow: boolean
  hasLayout: boolean
  bufferLength: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readSessionPartition(
  partition: string,
  session: unknown,
  webTabId: string
): OnDiskPartitionReading | null {
  if (!isRecord(session)) {
    return null
  }
  const tabsByWorktree = isRecord(session.tabsByWorktree) ? session.tabsByWorktree : {}
  const hasTabRow = Object.values(tabsByWorktree).some(
    (tabs) => Array.isArray(tabs) && tabs.some((tab) => isRecord(tab) && tab.id === webTabId)
  )
  const layouts = isRecord(session.terminalLayoutsByTabId) ? session.terminalLayoutsByTabId : {}
  const layout = layouts[webTabId]
  const hasLayout = isRecord(layout)
  const localOnlyHomes = isRecord(session.localOnlyScrollbackByTabId)
    ? session.localOnlyScrollbackByTabId
    : {}
  // Why the resolver: an ordinary park writes localOnlyScrollbackByTabId, not buffersByLeafId, so
  // a reader of one home reports a false zero. Same read production restores through.
  const buffers = resolveLeafScrollbackBuffers({
    shared: hasLayout ? { buffersByLeafId: stringRecord(layout.buffersByLeafId) } : undefined,
    localOnly: stringRecord(localOnlyHomes[webTabId])
  })
  const bufferLength = Object.values(buffers ?? {}).join('').length
  return { partition, hasTabRow, hasLayout, bufferLength }
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  )
}

/** Walks the local `workspaceSession` and every `workspaceSessionsByHostId` partition. An empty
 *  list means no session file was found at all — a reader problem, not an empty buffer. */
function readOnDiskPartitions(userDataDir: string, webTabId: string): OnDiskPartitionReading[] {
  const readings: OnDiskPartitionReading[] = []
  for (const file of globSync(path.join(userDataDir, '**', 'orca-data.json'))) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
      if (!isRecord(parsed)) {
        continue
      }
      const local = readSessionPartition('local', parsed.workspaceSession, webTabId)
      if (local) {
        readings.push(local)
      }
      const partitions = isRecord(parsed.workspaceSessionsByHostId)
        ? parsed.workspaceSessionsByHostId
        : {}
      for (const [hostId, session] of Object.entries(partitions)) {
        const reading = readSessionPartition(hostId, session, webTabId)
        if (reading) {
          readings.push(reading)
        }
      }
    } catch {
      // A partially written profile is itself a datapoint; keep scanning the rest.
    }
  }
  return readings
}

/** Bytes the remote host's own partition holds for the tab; -1 when no partition names it. */
function runtimePartitionBufferLength(readings: OnDiskPartitionReading[]): number {
  const runtime = readings.filter((reading) => reading.partition.startsWith('runtime:'))
  return runtime.length === 0 ? -1 : Math.max(...runtime.map((reading) => reading.bufferLength))
}

/** Bytes any 'local' partition reading holds for the tab; the pre-fix bug parked a stripped (0) or
 *  buffered copy here instead of in the remote host's partition. */
function localPartitionBufferLength(readings: OnDiskPartitionReading[]): number {
  const local = readings.filter((reading) => reading.partition === 'local')
  return local.length === 0 ? -1 : Math.max(...local.map((reading) => reading.bufferLength))
}

async function waitForRuntimePartitionCapture(
  userDataDir: string,
  webTabId: string
): Promise<OnDiskPartitionReading[]> {
  const deadline = Date.now() + DEBOUNCED_WRITE_BUDGET_MS
  let readings = readOnDiskPartitions(userDataDir, webTabId)
  while (runtimePartitionBufferLength(readings) <= 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    readings = readOnDiskPartitions(userDataDir, webTabId)
  }
  return readings
}

async function readStoreBufferLength(page: Page, webTabId: string): Promise<number> {
  // Why the debug handle: this body runs in the renderer, so it reaches the resolver through the
  // e2e handle rather than reading either store home directly.
  return page.evaluate((id) => {
    const buffers = window.__terminalParkingDebug?.resolveLeafScrollback(id)
    return Object.values(buffers ?? {}).join('').length
  }, webTabId)
}

async function activateWorktree(page: Page, worktreeId: string): Promise<void> {
  await page.evaluate((id) => {
    const state = window.__store?.getState()
    state?.setActiveView('terminal')
    state?.setActiveWorktree(id)
  }, worktreeId)
}

type ParkedRemoteTerminal = {
  client: PairedElectronClient
  worktreeId: string
  webTabId: string
  token: string
  tokenBeforePark: boolean
  storeAtPark: number
}

/** Open a remote-runtime terminal on the paired client, type a token into it, and cold-park it
 *  behind two decoy tabs. The token exists only in that pane's buffer — nothing replays stdin.
 *  Every host terminal it creates is pushed into `createdTerminals` as it is created, so the
 *  caller's `finally` can close them even if this throws partway. */
async function parkRemoteTerminalWithToken(
  orcaPage: Page,
  client: PairedElectronClient,
  createdTerminals: string[]
): Promise<ParkedRemoteTerminal> {
  const worktreeId = await orcaPage.evaluate(() => {
    const id = window.__store?.getState().activeWorktreeId
    if (!id) {
      throw new Error('headed host has no active worktree')
    }
    return id
  })
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
  await activateWorktree(client.page, worktreeId)

  const target = await createPairedHostTerminal(
    client.page,
    client.environmentId,
    worktreeId,
    fixtureCommand()
  )
  createdTerminals.push(target.terminal)
  const decoys = []
  for (let index = 0; index < 2; index += 1) {
    const decoy = await createPairedHostTerminal(
      client.page,
      client.environmentId,
      worktreeId,
      fixtureCommand()
    )
    createdTerminals.push(decoy.terminal)
    decoys.push(decoy)
  }

  await openPairedClientTab(client.page, worktreeId, target.webTabId)
  await waitForPairedPaneMarker(client.page, target.webTabId, 'READY', PAINT_BUDGET_MS)
  const token = `LINE:token-${randomUUID()}`
  await focusActiveTerminalInput(client.page)
  await client.page.keyboard.type(token.slice('LINE:'.length))
  await client.page.keyboard.press('Enter')
  const tokenBeforePark = await waitForPairedPaneMarker(
    client.page,
    target.webTabId,
    token,
    PAINT_BUDGET_MS
  )

  for (const decoy of decoys) {
    await openPairedClientTab(client.page, worktreeId, decoy.webTabId)
  }
  await waitForTabParked(client.page, target.webTabId, { parkDelayMs: PARK_DELAY_MS })
  const storeAtPark = await readStoreBufferLength(client.page, target.webTabId)
  return { client, worktreeId, webTabId: target.webTabId, token, tokenBeforePark, storeAtPark }
}

async function relaunchAndReveal(
  offer: Awaited<ReturnType<typeof createRuntimeDesktopPairingOffer>>,
  testInfo: TestInfo,
  parked: ParkedRemoteTerminal,
  extraEnv: Record<string, string>
): Promise<{
  relaunched: PairedElectronClient
  storeAfterRelaunch: number
  tokenAfterReveal: boolean
}> {
  const relaunched = await launchPairedElectronClient(offer, testInfo, 'parked-restart-relaunch', {
    extraEnv,
    reuseUserDataDir: parked.client.userDataDir
  })
  await activateWorktree(relaunched.page, parked.worktreeId)
  const storeAfterRelaunch = await readStoreBufferLength(relaunched.page, parked.webTabId)
  await openPairedClientTab(relaunched.page, parked.worktreeId, parked.webTabId)
  const tokenAfterReveal = await waitForPairedPaneMarker(
    relaunched.page,
    parked.webTabId,
    parked.token,
    PAINT_BUDGET_MS
  )
  return { relaunched, storeAfterRelaunch, tokenAfterReveal }
}

async function closeCreatedTerminals(
  client: PairedElectronClient,
  createdTerminals: readonly string[]
): Promise<void> {
  for (const terminal of createdTerminals) {
    await callEnvironment(client.page, client.environmentId, 'terminal.closeTab', {
      terminal
    }).catch(() => undefined)
  }
}

test.describe('host retains nothing', () => {
  test.use({
    orcaAppExtraEnv: { ORCA_E2E_FORCE_REMOTE_TERMINAL_SNAPSHOT_UNAVAILABLE: '1' }
  })

  test('the debounced write alone lands the parked scrollback in the remote host’s partition, so a hard kill loses nothing', async ({
    orcaPage
  }, testInfo) => {
    test.setTimeout(600_000)
    const offer = await createRuntimeDesktopPairingOffer(orcaPage)
    const extraEnv = { ORCA_E2E_TERMINAL_PARKING_DELAY_MS: String(PARK_DELAY_MS) }
    const first = await launchPairedElectronClient(offer, testInfo, 'parked-kill', { extraEnv })
    const userDataDir = first.userDataDir
    const createdTerminals: string[] = []
    let relaunched: PairedElectronClient | null = null
    try {
      const parked = await parkRemoteTerminalWithToken(orcaPage, first, createdTerminals)

      // Why no beforeunload and no ordinary close: both run the shutdown checkpoint, whose full
      // snapshot routes the layout correctly and would mask a misrouted debounced patch. Only the
      // debounced patch writer runs between the park and this kill.
      const onDiskAfterPark = await waitForRuntimePartitionCapture(userDataDir, parked.webTabId)
      await forceQuitElectronAppForE2E(first.app)
      await cleanupE2EDaemons(userDataDir)

      const reveal = await relaunchAndReveal(offer, testInfo, parked, extraEnv)
      relaunched = reveal.relaunched

      console.log(
        `[parked-restart] hard-kill ${JSON.stringify({
          tokenBeforePark: parked.tokenBeforePark,
          storeAtPark: parked.storeAtPark,
          onDiskAfterPark,
          storeAfterRelaunch: reveal.storeAfterRelaunch,
          tokenAfterReveal: reveal.tokenAfterReveal
        })}`
      )
      expect({
        tokenBeforePark: parked.tokenBeforePark,
        capturedAtPark: parked.storeAtPark > 0,
        profileSurvived: onDiskAfterPark.length > 0,
        // The load-bearing assertion: the debounced writer routed the capture to the remote host's
        // own partition, and did not leave it stripped in 'local'. This is what fails on `main`.
        runtimePartitionHoldsCapture: runtimePartitionBufferLength(onDiskAfterPark) > 0,
        localPartitionDidNotKeepCapture: localPartitionBufferLength(onDiskAfterPark) <= 0,
        // Secondary: the reveal may be served by the live host's retained tail rather than the
        // disk copy, so it is not the fix's oracle — it confirms relaunch and a visible pane.
        tokenAfterReveal: reveal.tokenAfterReveal
      }).toEqual({
        tokenBeforePark: true,
        capturedAtPark: true,
        profileSurvived: true,
        runtimePartitionHoldsCapture: true,
        localPartitionDidNotKeepCapture: true,
        tokenAfterReveal: true
      })
    } finally {
      const live = relaunched ?? first
      await closeCreatedTerminals(live, createdTerminals)
      await live.dispose().catch(() => undefined)
    }
  })

  test('a clean quit also lands the parked scrollback in the remote host’s partition (control)', async ({
    orcaPage
  }, testInfo) => {
    test.setTimeout(600_000)
    const offer = await createRuntimeDesktopPairingOffer(orcaPage)
    const extraEnv = { ORCA_E2E_TERMINAL_PARKING_DELAY_MS: String(PARK_DELAY_MS) }
    const first = await launchPairedElectronClient(offer, testInfo, 'parked-restart', { extraEnv })
    const userDataDir = first.userDataDir
    const createdTerminals: string[] = []
    let relaunched: PairedElectronClient | null = null
    try {
      const parked = await parkRemoteTerminalWithToken(orcaPage, first, createdTerminals)

      await first.page.evaluate(() => window.dispatchEvent(new Event('beforeunload')))
      await first.quitPreservingProfile()
      const onDiskAfterQuit = readOnDiskPartitions(userDataDir, parked.webTabId)

      const reveal = await relaunchAndReveal(offer, testInfo, parked, extraEnv)
      relaunched = reveal.relaunched

      console.log(
        `[parked-restart] clean-quit ${JSON.stringify({
          tokenBeforePark: parked.tokenBeforePark,
          storeAtPark: parked.storeAtPark,
          onDiskAfterQuit,
          storeAfterRelaunch: reveal.storeAfterRelaunch,
          tokenAfterReveal: reveal.tokenAfterReveal
        })}`
      )
      // Why tokenAfterReveal is logged and not asserted here: this control proves the harness
      // (park, quit, profile, partition routing), not the reveal. On identical product code the
      // clean-quit reveal measured true, true, false across three runs — the live host may serve
      // it from its own tail — so it cannot carry an assertion. The hard-kill test keeps it,
      // because there the host is forced unavailable and the reveal must come from the client copy.
      expect({
        tokenBeforePark: parked.tokenBeforePark,
        capturedAtPark: parked.storeAtPark > 0,
        // Distinguishes a deleted profile (no partitions) from an empty buffer.
        profileSurvived: onDiskAfterQuit.length > 0,
        runtimePartitionHoldsCapture: runtimePartitionBufferLength(onDiskAfterQuit) > 0,
        localPartitionDidNotKeepCapture: localPartitionBufferLength(onDiskAfterQuit) <= 0
      }).toEqual({
        tokenBeforePark: true,
        capturedAtPark: true,
        profileSurvived: true,
        runtimePartitionHoldsCapture: true,
        localPartitionDidNotKeepCapture: true
      })
    } finally {
      const live = relaunched ?? first
      await closeCreatedTerminals(live, createdTerminals)
      await live.dispose().catch(() => undefined)
    }
  })
})
