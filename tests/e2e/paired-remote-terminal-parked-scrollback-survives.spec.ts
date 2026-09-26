/**
 * Paired remote server: a cold-parked remote terminal must not lose its scrollback when the host
 * cannot answer the restore the park was licensed against.
 *
 * Topology: headed Orca desktop host (remote server) + a separate paired Orca desktop client —
 * the "SSH into the box, open the workspace, switch away, come back" shape. A remote-runtime
 * pty's bytes never transit the client's main process, so the client's xterm buffer is the only
 * client-side copy, and the paired-parking capability that licenses the unmount is a static build
 * string that says nothing about whether the host retained this pty's buffer.
 *
 * Oracle: a token the test typed into the terminal before the park, echoed back by the fixture, is
 * still in the revealed pane's buffer. Nothing replays stdin, so a respawned command cannot
 * reproduce that line — only the pre-park buffer can.
 *
 * Three scenarios, two parks:
 *   - "host retains the buffer" is the control for the ordinary park. It fails if the harness never
 *     parks, never reveals, or never echoed the token in the first place — so a green regression
 *     case cannot be green for an unrelated reason.
 *   - "host retains nothing" is the ordinary-park regression. ORCA_E2E_FORCE_REMOTE_TERMINAL_SNAPSHOT_UNAVAILABLE
 *     makes the host answer `no-serializable-buffer` — the state a client cannot tell apart from a
 *     host that is merely slow. Pre-fix the reveal paints an empty pane.
 *   - "force-park" is the retention-budget park. It is the only park that still writes the shared
 *     layout's `buffersByLeafId`, so it is where the mirrored-layout carry-through
 *     (`retainLocalScrollbackInRemoteLayout`) is load-bearing; the ordinary park's bytes live in
 *     `localOnlyScrollbackByTabId`, which a host inventory frame cannot reach by construction.
 *
 * Run:
 *   pnpm exec playwright test \
 *     tests/e2e/paired-remote-terminal-parked-scrollback-survives.spec.ts \
 *     --config tests/playwright.config.ts --project electron-headless --workers=1
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
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

const PARK_DELAY_MS = 2_000
const PAINT_BUDGET_MS = 30_000
const scratch = mkdtempSync(path.join(os.tmpdir(), 'orca-parked-scrollback-'))

// Why the token arrives over stdin rather than argv or a startup write: a respawn of the same
// command reprints anything baked into the command, and a startup write only reaches a client
// that was already subscribed — which the forced-unavailable host snapshot makes racy. Nothing
// replays stdin, so an echoed line can only come back from the buffer that was there pre-park.
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function fixtureCommand(): string {
  const command = [process.execPath, fixturePath]
  return process.platform === 'win32'
    ? command.map((value) => `"${value.replaceAll('"', '""')}"`).join(' ')
    : command.map(shellQuote).join(' ')
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

/** Reads both scrollback homes for a tab straight out of the store. The reveal is not a valid
 *  oracle for where the bytes live — a live host repaints a reveal whether or not the capture ran. */
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

/** Ordinary park: the target hides behind two decoys in its own worktree. Two decoys because the
 *  most recently hidden tab is exempt from cold-park (#8262) — one hides the target, the second
 *  moves the exemption. */
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

/** Force-park: the host does not advertise paired parking, so the target's worktree is one the
 *  ordinary park can never evict. A second hidden worktree pushes it past a retention budget of
 *  one; the newest hidden worktree keeps the last-active exemption, so the older one — the
 *  target's — is what the budget force-parks. */
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

/** Creates a host terminal, mirrors it on the client, parks it, forces a host inventory frame into
 *  the park→reveal window, reveals it, and reports where the bytes went and whether they came back. */
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

  // Logged, not asserted: on failure this is the whole diagnosis — whether the park left a client
  // copy at all, and if not, whether the repo catalog ruled the worktree local.
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

  // Why a forced inventory frame: without one this spec passes whether or not the mirrored-layout
  // rebuild carries the shared capture, because no frame happens to land in its window. A host
  // frame rebuilds the tab's layout bufferless; terminalLayoutEqual compares buffers, so the write
  // is not bailed out and apply-terminal-records assigns it wholesale. For the force-park, whose
  // bytes live in the layout, that is the destroying event, so it belongs inside the window under
  // test. For the ordinary park the frame proves the local-only home is out of its reach.
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
  testInfo: Parameters<Parameters<typeof test>[1]>[1],
  clientName: string,
  parkKind: ParkKind
): Promise<ParkRevealOutcome> {
  const offer = await createRuntimeDesktopPairingOffer(orcaPage)
  const client = await launchPairedElectronClient(offer, testInfo, clientName, {
    extraEnv: {
      ORCA_E2E_TERMINAL_PARKING_DELAY_MS: String(PARK_DELAY_MS),
      // Why limit=1 on every client: it is inert for the ordinary park (that worktree is
      // ordinarily parkable, so the budget never ranks it) and is what makes the force-park cheap.
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

// Why parkedHome is part of the expected shape: it is the upload contract, read from the store
// rather than inferred from the reveal. An ordinary park that lands in the shared layout would
// still reveal fine and would put tens of MiB back on every replace-session.
const RESTORED_LOCAL_ONLY: ParkRevealOutcome = {
  tokenBeforePark: true,
  parked: true,
  parkedHome: 'local-only',
  tokenAfterReveal: true
}
// Why tokenAfterReveal is logged and not asserted here: a host without paired parking serves the
// reattach from its own tail and paints it over whatever the client replayed at mount
// (apply-reattach-payload clears the screen first), so on this topology it cannot speak for the
// client copy — it measured false once and true twice with the copy intact. The retention fix is
// proven where it acts: the shared layout still holds the bytes after the forced inventory frame
// (`survivedInventoryFrame` above). It is left out of the assertion rather than matched loosely.
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
      // Why: without the paired-parking capability the worktree is un-parkable, which is the class
      // the retention budget governs — the only way to reach a force-park on this topology.
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
