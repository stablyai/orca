/**
 * Paired remote server: a revealed remote terminal must stay interactive
 * without a tab flip.
 *
 * Topology: headed Orca desktop host (remote server) + a separate paired Orca
 * desktop client — the "connect to Windows 2, open an old workspace" shape.
 *
 * Oracle (the reported symptom verbatim): type into the revealed pane and see
 * the echo paint live. "Paints only after switching to another terminal and
 * back" is the failure, so each scenario records both.
 *
 * The decoy tabs are load-bearing, not scenery. Pre-fix, handleClose never runs,
 * so closeIfIdle is the only remaining release path and it needs zero streams —
 * a sibling stream is what keeps the wedged multiplexer alive and the pre-fix
 * state red. Each scenario asserts its flip decoy is still mounted at the reveal
 * so that invariant cannot quietly lapse and turn this green.
 *
 * Run:
 *   pnpm exec playwright test \
 *     tests/e2e/paired-remote-terminal-parked-reveal-interactivity.spec.ts \
 *     --config tests/playwright.config.ts --project electron-headless --workers=1
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import {
  HOST_TERMINAL_SURFACE_SEPARATOR,
  toWebTerminalSurfaceTabId
} from '../../src/shared/terminal-surface-id'
import { expect, test } from './helpers/orca-app'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import { focusActiveTerminalInput } from './helpers/terminal'
import { waitForTabParked } from './helpers/terminal-hidden-parking'

const PARK_DELAY_MS = 2_000
const LIVE_PAINT_BUDGET_MS = 12_000
const REVEAL_BUDGET_MS = 20_000
const scratch = mkdtempSync(path.join(os.tmpdir(), 'orca-parked-reveal-'))
const fixturePath = path.join(scratch, 'parked-reveal-terminal.mjs')
writeFileSync(
  fixturePath,
  [
    "import { appendFileSync } from 'node:fs'",
    'const sink = process.argv[2]',
    'const size = () => `${process.stdout.columns}x${process.stdout.rows}`',
    'const record = (line) => appendFileSync(sink, `${line}\\n`)',
    'record(`READY:${size()}`)',
    'process.stdout.write(`READY:${size()}\\r\\n`)',
    "process.stdout.on('resize', () => {",
    '  record(`SIZE:${size()}`)',
    '  process.stdout.write(`SIZE:${size()}\\r\\n`)',
    '})',
    "process.stdin.setEncoding('utf8')",
    "let pending = ''",
    "process.stdin.on('data', (data) => {",
    '  pending += data',
    '  const lines = pending.split(/\\r\\n|\\r|\\n/)',
    "  pending = lines.pop() ?? ''",
    '  for (const line of lines) {',
    '    record(`LINE:${line}`)',
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

function fixtureCommand(sinkPath: string): string {
  const command = [process.execPath, fixturePath, sinkPath]
  return process.platform === 'win32'
    ? command.map((value) => `"${value.replaceAll('"', '""')}"`).join(' ')
    : command.map(shellQuote).join(' ')
}

function readSink(sinkPath: string): string {
  try {
    return readFileSync(sinkPath, 'utf8')
  } catch {
    return ''
  }
}

async function callEnvironment<TResult>(
  page: Page,
  environmentId: string,
  method: string,
  params: unknown
): Promise<TResult> {
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

type HostTerminal = {
  hostTabId: string
  sinkPath: string
  terminal: string
  webTabId: string
}

async function createHostTerminal(
  page: Page,
  environmentId: string,
  worktreeId: string
): Promise<HostTerminal> {
  const sinkPath = path.join(scratch, `sink-${randomUUID()}.log`)
  const result = await callEnvironment<{ tab: { id: string; terminal: string | null } }>(
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
  if (!result.tab.terminal) {
    throw new Error('host session terminal was not created')
  }
  // Why: the host answers with a `tabId::leafId` surface id; client tabs mirror the parent tab.
  const hostTabId = result.tab.id.split(HOST_TERMINAL_SURFACE_SEPARATOR)[0]
  return {
    hostTabId,
    sinkPath,
    terminal: result.tab.terminal,
    webTabId: toWebTerminalSurfaceTabId(hostTabId)
  }
}

async function openClientTab(page: Page, worktreeId: string, webTabId: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          (id) => (window.__store?.getState().tabsByWorktree[id] ?? []).map((tab) => tab.id),
          worktreeId
        ),
      { timeout: 60_000, message: `client never mirrored host tab ${webTabId}` }
    )
    .toContain(webTabId)
  await page.evaluate(
    ({ webTabId, worktreeId }) => {
      const state = window.__store?.getState()
      state?.setActiveView('terminal')
      state?.setActiveWorktree(worktreeId)
      state?.setActiveTab(webTabId)
      state?.setActiveTabType('terminal')
    },
    { webTabId, worktreeId }
  )
  await expect
    .poll(() => page.evaluate((id) => window.__paneManagers?.has(id) ?? false, webTabId), {
      timeout: 60_000,
      message: `client pane for ${webTabId} did not mount`
    })
    .toBe(true)
}

async function readActivePaneGrid(
  page: Page,
  webTabId: string
): Promise<{ cols: number; rows: number } | null> {
  return page.evaluate((id) => {
    const manager = window.__paneManagers?.get(id)
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    return pane ? { cols: pane.terminal.cols, rows: pane.terminal.rows } : null
  }, webTabId)
}

/** Reads the target tab's own buffer. `getTerminalContent` resolves whatever
 *  tab the store thinks is active, which hides per-tab reveal failures. */
async function readPaneContent(page: Page, webTabId: string): Promise<string> {
  return page.evaluate((id) => {
    const manager = window.__paneManagers?.get(id)
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    return pane?.serializeAddon?.serialize?.() ?? ''
  }, webTabId)
}

async function readPaneDiagnostics(
  page: Page,
  worktreeId: string,
  webTabId: string
): Promise<unknown> {
  return page.evaluate(
    ({ webTabId, worktreeId }) => {
      const manager = window.__paneManagers?.get(webTabId)
      const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
      const state = window.__store?.getState()
      const tab = (state?.tabsByWorktree[worktreeId] ?? []).find((entry) => entry.id === webTabId)
      return {
        mounted: Boolean(manager),
        ptyId: pane?.container?.dataset?.ptyId ?? null,
        recoveryState: pane?.container?.dataset?.ptyRecoveryState ?? null,
        cols: pane?.terminal?.cols ?? null,
        rows: pane?.terminal?.rows ?? null,
        bufferLength: pane?.serializeAddon?.serialize?.()?.length ?? null,
        paneLeafIds: manager?.getPanes?.().map((entry) => entry.leafId ?? null) ?? null,
        storeTabPtyId: tab?.ptyId ?? null,
        storeTabLayout: tab?.paneLayout ? JSON.stringify(tab.paneLayout) : null,
        storePtyIdsByTab: state?.ptyIdsByTabId?.[webTabId] ?? null
      }
    },
    { webTabId, worktreeId }
  )
}

async function waitForPaneMarker(
  page: Page,
  webTabId: string,
  marker: string,
  budgetMs: number
): Promise<boolean> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if ((await readPaneContent(page, webTabId)).includes(marker)) {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return false
}

function readPtyGridFromContent(content: string): { cols: number; rows: number } | null {
  const sizes = [...content.matchAll(/(?:READY|SIZE):(\d+)x(\d+)/g)]
  const last = sizes.at(-1)
  return last ? { cols: Number(last[1]), rows: Number(last[2]) } : null
}

type ScenarioResult = {
  name: string
  restoredBuffer: boolean
  hostReceivedInput: boolean
  paintedLive: boolean
  paintedAfterFlip: boolean
  paneGrid: { cols: number; rows: number } | null
  ptyGrid: { cols: number; rows: number } | null
  diagnostics: unknown
}

/** Types a unique marker into the revealed pane and records whether the host
 *  received it, whether it painted live, and (if not) whether the reported
 *  tab-flip workaround reveals it. */
async function probeInteractivity(
  page: Page,
  worktreeId: string,
  target: HostTerminal,
  flipTo: HostTerminal,
  name: string
): Promise<ScenarioResult> {
  const token = `probe-${name}`
  // Why: a human types once the pane looks restored; typing earlier would race the reattach.
  const restoredBuffer = await waitForPaneMarker(page, target.webTabId, 'READY:', REVEAL_BUDGET_MS)
  await focusActiveTerminalInput(page)
  await page.keyboard.type(token)
  await page.keyboard.press('Enter')
  const paintedLive = await waitForPaneMarker(
    page,
    target.webTabId,
    `LINE:${token}`,
    LIVE_PAINT_BUDGET_MS
  )
  const paneGrid = await readActivePaneGrid(page, target.webTabId)
  const diagnostics = await readPaneDiagnostics(page, worktreeId, target.webTabId)
  let paintedAfterFlip = paintedLive
  if (!paintedLive) {
    await openClientTab(page, worktreeId, flipTo.webTabId)
    await openClientTab(page, worktreeId, target.webTabId)
    paintedAfterFlip = await waitForPaneMarker(
      page,
      target.webTabId,
      `LINE:${token}`,
      LIVE_PAINT_BUDGET_MS
    )
  }
  const sink = readSink(target.sinkPath)
  return {
    name,
    restoredBuffer,
    hostReceivedInput: sink.includes(`LINE:${token}`),
    paintedLive,
    paintedAfterFlip,
    paneGrid,
    ptyGrid: readPtyGridFromContent(sink),
    diagnostics
  }
}

/** The wedged-multiplexer repro needs a sibling stream alive at reveal time
 *  (see the header), and S1 additionally needs its target never to have parked. */
async function expectStillMounted(page: Page, webTabId: string, label: string): Promise<void> {
  expect(
    await page.evaluate((id) => window.__paneManagers?.has(id) ?? false, webTabId),
    `${label} parked before the reveal it is supposed to survive`
  ).toBe(true)
}

/** Logged unconditionally: on failure this line is the whole diagnosis. */
function logResult(result: ScenarioResult): ScenarioResult {
  console.log(`[paired-reveal] ${JSON.stringify(result)}`)
  return result
}

async function seedScenario(
  client: PairedElectronClient,
  worktreeId: string
): Promise<{ target: HostTerminal; decoys: HostTerminal[] }> {
  const target = await createHostTerminal(client.page, client.environmentId, worktreeId)
  const decoys = [
    await createHostTerminal(client.page, client.environmentId, worktreeId),
    await createHostTerminal(client.page, client.environmentId, worktreeId)
  ]
  await openClientTab(client.page, worktreeId, target.webTabId)
  await expect
    .poll(() => readPaneContent(client.page, target.webTabId), {
      timeout: 60_000,
      message: 'target terminal never painted its READY marker'
    })
    .toContain('READY:')
  return { target, decoys }
}

test('paired client keeps revealed remote terminals interactive', async ({
  orcaPage
}, testInfo) => {
  test.setTimeout(600_000)
  const offer = await createRuntimeDesktopPairingOffer(orcaPage)
  // Why: the paired client inherits this from the launching process; a reused
  // Playwright worker would otherwise leak the shortened delay into later specs.
  const previousParkDelay = process.env.ORCA_E2E_TERMINAL_PARKING_DELAY_MS
  process.env.ORCA_E2E_TERMINAL_PARKING_DELAY_MS = String(PARK_DELAY_MS)
  const client = await launchPairedElectronClient(offer, testInfo, 'parked-reveal')
  const createdTerminals: string[] = []
  const results: ScenarioResult[] = []
  try {
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
    await client.page.evaluate((id) => {
      const state = window.__store?.getState()
      state?.setActiveView('terminal')
      state?.setActiveWorktree(id)
    }, worktreeId)

    // S1 — hidden tab that stays mounted, then revealed.
    {
      const { target, decoys } = await seedScenario(client, worktreeId)
      createdTerminals.push(target.terminal, ...decoys.map((decoy) => decoy.terminal))
      await openClientTab(client.page, worktreeId, decoys[0].webTabId)
      // Pins the scenario label: this reveal must not have gone through a park.
      await expectStillMounted(client.page, target.webTabId, 'hidden-mounted target')
      await openClientTab(client.page, worktreeId, target.webTabId)
      results.push(
        logResult(
          await probeInteractivity(client.page, worktreeId, target, decoys[1], 'hidden-mounted')
        )
      )
    }

    // S2 — cold-parked tab (renderer unmounted), then revealed.
    {
      const { target, decoys } = await seedScenario(client, worktreeId)
      createdTerminals.push(target.terminal, ...decoys.map((decoy) => decoy.terminal))
      await openClientTab(client.page, worktreeId, decoys[0].webTabId)
      await openClientTab(client.page, worktreeId, decoys[1].webTabId)
      await waitForTabParked(client.page, target.webTabId, { parkDelayMs: PARK_DELAY_MS })
      await expectStillMounted(client.page, decoys[1].webTabId, 'cold-parked flip decoy')
      await openClientTab(client.page, worktreeId, target.webTabId)
      results.push(
        logResult(
          await probeInteractivity(client.page, worktreeId, target, decoys[1], 'cold-parked')
        )
      )
    }

    // S3 — cold-parked tab whose runtime connection dropped and came back
    // while parked (the "returned after a while" report).
    {
      const { target, decoys } = await seedScenario(client, worktreeId)
      createdTerminals.push(target.terminal, ...decoys.map((decoy) => decoy.terminal))
      await openClientTab(client.page, worktreeId, decoys[0].webTabId)
      await openClientTab(client.page, worktreeId, decoys[1].webTabId)
      await waitForTabParked(client.page, target.webTabId, { parkDelayMs: PARK_DELAY_MS })
      await client.page.evaluate(async (selector) => {
        await window.api.runtimeEnvironments.disconnect({ selector })
      }, client.environmentId)
      await expect
        .poll(
          async () =>
            client.page.evaluate(async (selector) => {
              const response = await window.api.runtimeEnvironments.connect({ selector })
              return response.ok
            }, client.environmentId),
          { timeout: 60_000, message: 'paired client never reconnected to the host runtime' }
        )
        .toBe(true)
      await expectStillMounted(client.page, decoys[1].webTabId, 'reconnect-parked flip decoy')
      await openClientTab(client.page, worktreeId, target.webTabId)
      results.push(
        logResult(
          await probeInteractivity(client.page, worktreeId, target, decoys[1], 'reconnect-parked')
        )
      )
    }

    for (const result of results) {
      expect(
        {
          scenario: result.name,
          restoredBuffer: result.restoredBuffer,
          hostReceivedInput: result.hostReceivedInput,
          paintedLive: result.paintedLive
        },
        `${result.name}: revealed pane was not interactive (painted after tab flip: ${result.paintedAfterFlip})`
      ).toEqual({
        scenario: result.name,
        restoredBuffer: true,
        hostReceivedInput: true,
        paintedLive: true
      })
      expect(
        { scenario: result.name, ptyGrid: result.ptyGrid },
        `${result.name}: host PTY geometry never converged on the revealed pane grid`
      ).toEqual({ scenario: result.name, ptyGrid: result.paneGrid })
    }
  } finally {
    if (previousParkDelay === undefined) {
      delete process.env.ORCA_E2E_TERMINAL_PARKING_DELAY_MS
    } else {
      process.env.ORCA_E2E_TERMINAL_PARKING_DELAY_MS = previousParkDelay
    }
    for (const terminal of createdTerminals) {
      await callEnvironment(client.page, client.environmentId, 'terminal.closeTab', {
        terminal
      }).catch(() => undefined)
    }
    await client.dispose()
  }
})
