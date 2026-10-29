// Retain client scrollback when a paired desktop host cannot serialize the parked PTY.
// Control ordinary park with a live host; force no-serializable-buffer to isolate local replay; force-park to test shared buffersByLeafId carry-through.
// Ordinary parks use localOnlyScrollbackByTabId; force-parks must survive host layout frames in the shared home.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

import os from 'node:os'
import path from 'node:path'
import type { Page, TestInfo } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient
} from './helpers/paired-electron-client'
import {
  callEnvironment,
  createPairedHostTerminal,
  openPairedClientTab,
  waitForPairedPaneMarker,
  type PairedHostTerminal
} from './helpers/paired-host-terminal'
import { focusActiveTerminalInput } from './helpers/terminal'
import { waitForTabParked } from './helpers/terminal-hidden-parking'
import { quotePosixShell } from '../../src/shared/shell-argument-quoting'

const PARK_DELAY_MS = 2_000
const PAINT_BUDGET_MS = 30_000
const scratch = mkdtempSync(path.join(os.tmpdir(), 'orca-parked-scrollback-'))

// Send the token only through stdin: startup/argv text reappears on respawn, while only the old buffer can retain this echo.
const fixturePath = path.join(scratch, 'parked-scrollback-terminal.mjs')
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
    : command.map(quotePosixShell).join(' ')
}

type ParkKind = 'ordinary' | 'force'

type ParkRevealOutcome = {
  /** The echoed token painted live before the park, so the pane really held it. */
  tokenBeforePark: boolean
  parked: boolean
  /** Which scrollback home the park wrote. Ordinary parks must stay off the upload; force-parks
   *  must stay on it, because a second desktop cold-restores from the shared copy. */
  parkedHome: 'local-only' | 'shared' | 'both' | 'none'
  /** The same echoed line is back. Nothing replays stdin, so a respawn cannot produce it. */
  tokenAfterReveal: boolean
}

type ScrollbackHomes = {
  sharedLength: number
  localOnlyLength: number
  layoutKnown: boolean
}

async function readHostWorktreeIds(page: Page): Promise<{ primary: string; secondary: string }> {
  return page.evaluate(() => {
    const state = window.__store?.getState()
    const primary = state?.activeWorktreeId
    if (!primary) {
      throw new Error('headed host has no active worktree')
    }
    const secondary = state.allWorktrees().find((worktree) => worktree.id !== primary)?.id
    if (!secondary) {
      throw new Error('headed host has no second seeded worktree for the force-park scenario')
    }
    return { primary, secondary }
  })
}

// Read both scrollback homes directly; a host-served reveal cannot prove where client bytes persisted.
async function readScrollbackHomes(clientPage: Page, webTabId: string): Promise<ScrollbackHomes> {
  return clientPage.evaluate((id) => {
    const state = window.__store?.getState()
    const layout = state?.terminalLayoutsByTabId?.[id]
    return {
      sharedLength: Object.values(layout?.buffersByLeafId ?? {}).join('').length,
      localOnlyLength: Object.values(state?.localOnlyScrollbackByTabId?.[id] ?? {}).join('').length,
      layoutKnown: layout !== undefined
    }
  }, webTabId)
}

function classifyParkedHome(homes: ScrollbackHomes): ParkRevealOutcome['parkedHome'] {
  if (homes.sharedLength > 0 && homes.localOnlyLength > 0) {
    return 'both'
  }
  if (homes.sharedLength > 0) {
    return 'shared'
  }
  return homes.localOnlyLength > 0 ? 'local-only' : 'none'
}

async function typeToken(
  clientPage: Page,
  webTabId: string
): Promise<{ token: string; painted: boolean }> {
  const token = `LINE:token-${randomUUID()}`
  await focusActiveTerminalInput(clientPage)
  await clientPage.keyboard.type(token.slice('LINE:'.length))
  await clientPage.keyboard.press('Enter')
  const painted = await waitForPairedPaneMarker(clientPage, webTabId, token, PAINT_BUDGET_MS)
  return { token, painted }
}

// Hide behind two decoys because #8262 exempts the most recently hidden tab.
async function parkOrdinarily(
  clientPage: Page,
  environmentId: string,
  worktreeId: string,
  createdTerminals: string[]
): Promise<void> {
  const decoys: PairedHostTerminal[] = []
  for (let index = 0; index < 2; index += 1) {
    decoys.push(
      await createPairedHostTerminal(clientPage, environmentId, worktreeId, fixtureCommand())
    )
  }
  createdTerminals.push(...decoys.map((decoy) => decoy.terminal))
  await openPairedClientTab(clientPage, worktreeId, decoys[0].webTabId)
  await openPairedClientTab(clientPage, worktreeId, decoys[1].webTabId)
}

// Without paired-parking capability, use two hidden worktrees and retention budget one so the older target is force-parked.
async function parkByRetentionBudget(
  clientPage: Page,
  environmentId: string,
  otherWorktreeId: string,
  createdTerminals: string[]
): Promise<void> {
  const decoy = await createPairedHostTerminal(
    clientPage,
    environmentId,
    otherWorktreeId,
    fixtureCommand()
  )
  createdTerminals.push(decoy.terminal)
  await openPairedClientTab(clientPage, otherWorktreeId, decoy.webTabId)
  await waitForPairedPaneMarker(clientPage, decoy.webTabId, 'READY', PAINT_BUDGET_MS)
  // Why a non-terminal view: both worktrees must be hidden for the budget to rank them.
  await clientPage.evaluate(() => window.__store?.getState().setActiveView('tasks'))
}

// Mirror/mark/park, force an inventory frame inside the park→reveal window, then report capture and restored echo.
async function runParkRevealScenario(args: {
  clientPage: Page
  environmentId: string
  worktreeId: string
  otherWorktreeId: string
  parkKind: ParkKind
  createdTerminals: string[]
}): Promise<ParkRevealOutcome> {
  const { clientPage, environmentId, worktreeId, otherWorktreeId, parkKind, createdTerminals } =
    args
  const target = await createPairedHostTerminal(
    clientPage,
    environmentId,
    worktreeId,
    fixtureCommand()
  )
  createdTerminals.push(target.terminal)

  await openPairedClientTab(clientPage, worktreeId, target.webTabId)
  await waitForPairedPaneMarker(clientPage, target.webTabId, 'READY', PAINT_BUDGET_MS)
  const { token, painted: tokenBeforePark } = await typeToken(clientPage, target.webTabId)

  await (parkKind === 'ordinary'
    ? parkOrdinarily(clientPage, environmentId, worktreeId, createdTerminals)
    : parkByRetentionBudget(clientPage, environmentId, otherWorktreeId, createdTerminals))
  let parked = true
  try {
    await waitForTabParked(clientPage, target.webTabId, { parkDelayMs: PARK_DELAY_MS })
  } catch {
    parked = false
  }

  // Log capture presence and catalog locality to diagnose failure.
  const afterPark = await readScrollbackHomes(clientPage, target.webTabId)
  const parkDiagnostics = await clientPage.evaluate(
    ({ webTabId, worktreeId }) => {
      const state = window.__store?.getState()
      const layout = state?.terminalLayoutsByTabId?.[webTabId]
      const repoId = worktreeId.split('::')[0]
      const repo = (state?.repos ?? []).find((entry) => entry.id === repoId)
      return {
        layoutRoot: layout?.root ? JSON.stringify(layout.root) : null,
        repoKnown: repo !== undefined,
        repoConnectionId: repo?.connectionId ?? null,
        repoExecutionHostId: repo?.executionHostId ?? null,
        forceParkVerdicts: window.__terminalParkingDebug?.worktreeVerdicts() ?? []
      }
    },
    { webTabId: target.webTabId, worktreeId }
  )
  console.log(
    `[parked-scrollback] after-park ${JSON.stringify({ parkKind, ...afterPark, ...parkDiagnostics })}`
  )
  const parkedHome = classifyParkedHome(afterPark)

  // Force a host frame inside the window: its bufferless layout rebuild would overwrite force-park’s shared capture.
  // Ordinary park’s local-only bytes must remain outside that upload/rebuild path.
  const probeTab = await createPairedHostTerminal(
    clientPage,
    environmentId,
    worktreeId,
    fixtureCommand()
  )
  createdTerminals.push(probeTab.terminal)
  await expect
    .poll(
      () =>
        clientPage.evaluate(
          (id) => (window.__store?.getState().tabsByWorktree[id] ?? []).map((tab) => tab.id),
          worktreeId
        ),
      {
        timeout: 60_000,
        message: 'client never mirrored the probe tab (no inventory frame landed)'
      }
    )
    .toContain(probeTab.webTabId)
  const afterInventoryFrame = await readScrollbackHomes(clientPage, target.webTabId)
  console.log(
    `[parked-scrollback] after-inventory-frame ${JSON.stringify({ parkKind, ...afterInventoryFrame })}`
  )
  const survivedInventoryFrame =
    parkKind === 'force'
      ? afterInventoryFrame.sharedLength > 0
      : afterInventoryFrame.localOnlyLength > 0
  expect(
    { survivedInventoryFrame },
    'a host inventory frame wiped the park capture before the reveal'
  ).toEqual({ survivedInventoryFrame: true })

  await openPairedClientTab(clientPage, worktreeId, target.webTabId)
  const tokenAfterReveal = await waitForPairedPaneMarker(
    clientPage,
    target.webTabId,
    token,
    PAINT_BUDGET_MS
  )
  return { tokenBeforePark, parked, parkedHome, tokenAfterReveal }
}

async function runScenario(
  orcaPage: Page,
  testInfo: TestInfo,
  clientName: string,
  parkKind: ParkKind
): Promise<ParkRevealOutcome> {
  const offer = await createRuntimeDesktopPairingOffer(orcaPage)
  const client = await launchPairedElectronClient(offer, testInfo, clientName, {
    extraEnv: {
      ORCA_E2E_TERMINAL_PARKING_DELAY_MS: String(PARK_DELAY_MS),
      // Budget one affects only force-park; ordinary-parkable worktrees bypass the budget ranker.
      ORCA_E2E_TERMINAL_RETENTION_LIMIT: '1'
    }
  })
  const createdTerminals: string[] = []
  try {
    const worktreeIds = await readHostWorktreeIds(orcaPage)
    await expect
      .poll(
        () =>
          client.page.evaluate(
            (ids) => {
              const known = new Set(
                window.__store
                  ?.getState()
                  .allWorktrees()
                  .map((worktree) => worktree.id)
              )
              return ids.every((id) => known.has(id))
            },
            [worktreeIds.primary, worktreeIds.secondary]
          ),
        { timeout: 60_000, message: 'paired client never saw both host worktrees' }
      )
      .toBe(true)
    await client.page.evaluate((id) => {
      const state = window.__store?.getState()
      state?.setActiveView('terminal')
      state?.setActiveWorktree(id)
    }, worktreeIds.primary)
    const outcome = await runParkRevealScenario({
      clientPage: client.page,
      environmentId: client.environmentId,
      worktreeId: worktreeIds.primary,
      otherWorktreeId: worktreeIds.secondary,
      parkKind,
      createdTerminals
    })
    console.log(`[parked-scrollback] ${clientName} ${JSON.stringify(outcome)}`)
    return outcome
  } finally {
    for (const terminal of createdTerminals) {
      await callEnvironment(client.page, client.environmentId, 'terminal.closeTab', {
        terminal
      }).catch(() => undefined)
    }
    await client.dispose()
  }
}

// Assert the upload home directly: ordinary park in shared layout would reveal fine but upload tens of MiB.
const RESTORED_LOCAL_ONLY: ParkRevealOutcome = {
  tokenBeforePark: true,
  parked: true,
  parkedHome: 'local-only',
  tokenAfterReveal: true
}
// Log force-park reveal only: live host tail replay can overwrite a correct client copy.
// Assert retention at its actual boundary, survivedInventoryFrame, instead.
const FORCE_PARKED_SHARED: Omit<ParkRevealOutcome, 'tokenAfterReveal'> = {
  tokenBeforePark: true,
  parked: true,
  parkedHome: 'shared'
}

test.describe('host retains the buffer', () => {
  test('a cold-parked remote terminal restores its scrollback on reveal', async ({
    orcaPage
  }, testInfo) => {
    test.setTimeout(600_000)
    expect(await runScenario(orcaPage, testInfo, 'host-retains', 'ordinary')).toEqual(
      RESTORED_LOCAL_ONLY
    )
  })
})

test.describe('host retains nothing', () => {
  test.use({
    orcaAppExtraEnv: { ORCA_E2E_FORCE_REMOTE_TERMINAL_SNAPSHOT_UNAVAILABLE: '1' }
  })

  test('a cold-parked remote terminal keeps its scrollback when the host cannot answer', async ({
    orcaPage
  }, testInfo) => {
    test.setTimeout(600_000)
    expect(await runScenario(orcaPage, testInfo, 'host-empty', 'ordinary')).toEqual(
      RESTORED_LOCAL_ONLY
    )
  })
})

test.describe('force-park with a host that cannot answer', () => {
  test.use({
    orcaAppExtraEnv: {
      ORCA_E2E_FORCE_REMOTE_TERMINAL_SNAPSHOT_UNAVAILABLE: '1',
      // Omit paired-parking capability so this topology reaches retention-budget force-park.
      ORCA_E2E_DISABLE_PAIRED_TERMINAL_PARKING: '1'
    }
  })

  test('a force-parked remote terminal keeps its shared-layout capture across an inventory frame', async ({
    orcaPage
  }, testInfo) => {
    test.setTimeout(600_000)
    const outcome = await runScenario(orcaPage, testInfo, 'force-park', 'force')
    expect({
      tokenBeforePark: outcome.tokenBeforePark,
      parked: outcome.parked,
      parkedHome: outcome.parkedHome
    }).toEqual(FORCE_PARKED_SHARED)
  })
})
