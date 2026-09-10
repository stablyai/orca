/**
 * #19647 "Orca has to reconnect every time I switch tabs".
 *
 * TOPOLOGY: real Orca desktop app as the remote server + a separate real Orca
 * desktop client paired to it, with every client->host byte routed through a TCP
 * hop whose fault mode this test controls. That hop is the reporter's Tailscale
 * link; `stall-new` reproduces its characteristic failure, where established
 * flows keep delivering (their agent kept working) while a freshly dialed
 * connection hangs.
 *
 * Exploratory-first: the `[tab-switch-repro]` census and timeline lines are the
 * diagnosis. The hard gate is the #19647 writer contract — a status.get the client
 * could not push through must not null a recorded live verdict, and recovery must not
 * advance the connection generation. Whether the pane repaints within budget is logged,
 * NOT asserted: that is gated on the un-park latch (#19872) and the multiplexer
 * cold-handshake (#19871), both filed separately. A green run is NOT a clean bill of health.
 *
 * Run:
 *   pnpm exec playwright test \
 *     tests/e2e/paired-remote-terminal-tab-switch-reconnect.spec.ts \
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
  launchPairedElectronClient
} from './helpers/paired-electron-client'
import {
  readPairingEndpoint,
  repointPairingUrl,
  startRuntimeEndpointLinkFault
} from './helpers/runtime-endpoint-link-fault'
import { waitForTabParked } from './helpers/terminal-hidden-parking'

const PARK_DELAY_MS = 2_000
const scratch = mkdtempSync(path.join(os.tmpdir(), 'orca-tab-switch-reconnect-'))
const fixturePath = path.join(scratch, 'tab-switch-terminal.mjs')
writeFileSync(
  fixturePath,
  [
    "import { appendFileSync } from 'node:fs'",
    'const sink = process.argv[2]',
    'const record = (line) => appendFileSync(sink, `${line}\\n`)',
    "record('READY')",
    "process.stdout.write('READY\\r\\n')",
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
  const result = await callEnvironment<{
    tab: { id: string; terminal: string | null }
  }>(page, environmentId, 'session.tabs.createTerminal', {
    worktree: `id:${worktreeId}`,
    command: fixtureCommand(sinkPath),
    activate: false,
    select: false,
    navigation: 'caller'
  })
  if (!result.tab.terminal) {
    throw new Error('host session terminal was not created')
  }
  const hostTabId = result.tab.id.split(HOST_TERMINAL_SURFACE_SEPARATOR)[0]
  return {
    hostTabId,
    sinkPath,
    terminal: result.tab.terminal,
    webTabId: toWebTerminalSurfaceTabId(hostTabId)
  }
}

async function waitForMirroredTab(page: Page, worktreeId: string, webTabId: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          (id) => (window.__store?.getState().tabsByWorktree[id] ?? []).map((tab) => tab.id),
          worktreeId
        ),
      {
        timeout: 60_000,
        message: `client never mirrored host tab ${webTabId}`
      }
    )
    .toContain(webTabId)
}

async function selectClientTab(page: Page, worktreeId: string, webTabId: string): Promise<void> {
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
}

async function openClientTab(page: Page, worktreeId: string, webTabId: string): Promise<void> {
  await waitForMirroredTab(page, worktreeId, webTabId)
  await selectClientTab(page, worktreeId, webTabId)
  await expect
    .poll(() => page.evaluate((id) => window.__paneManagers?.has(id) ?? false, webTabId), {
      timeout: 60_000,
      message: `client pane for ${webTabId} did not mount`
    })
    .toBe(true)
}

type MultiplexCensus = {
  activeStreamCount: number
  transportSubscribeCount: number
  transportUnsubscribeCount: number
  streamSubscribeCount: number
  streamUnsubscribeCount: number
}

async function readMultiplexCensus(page: Page): Promise<MultiplexCensus> {
  return page.evaluate(() => {
    const snapshot = (
      window as Window & {
        __remoteTerminalMultiplexAckGate?: {
          snapshot: () => {
            activeStreams: unknown[]
            transportSubscribeCount: number
            transportUnsubscribeCount: number
            streamSubscribeCount: number
            streamUnsubscribeCount: number
          }
        }
      }
    ).__remoteTerminalMultiplexAckGate?.snapshot()
    return {
      activeStreamCount: snapshot?.activeStreams.length ?? -1,
      transportSubscribeCount: snapshot?.transportSubscribeCount ?? -1,
      transportUnsubscribeCount: snapshot?.transportUnsubscribeCount ?? -1,
      streamSubscribeCount: snapshot?.streamSubscribeCount ?? -1,
      streamUnsubscribeCount: snapshot?.streamUnsubscribeCount ?? -1
    }
  })
}

type PaneObservation = {
  atMs: number
  banner: string | null
  recoveryState: string | null
  mounted: boolean
  nullStatusEnvironments: number
  connectionGeneration: number | null
  remoteControlState: string | null
}

async function observePane(
  page: Page,
  webTabId: string,
  environmentId: string,
  startedAt: number
): Promise<PaneObservation> {
  const observation = await page.evaluate(
    ({ id, environmentId }) => {
      const manager = window.__paneManagers?.get(id)
      const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
      const banner = document.querySelector('[data-terminal-remote-runtime-reconnect-banner]')
      const statuses = window.__store?.getState().runtimeStatusByEnvironmentId
      let nullStatusEnvironments = 0
      for (const entry of statuses?.values() ?? []) {
        if (entry.status === null) {
          nullStatusEnvironments += 1
        }
      }
      return {
        banner: banner?.getAttribute('data-terminal-remote-runtime-reconnect-banner') ?? null,
        recoveryState: pane?.container?.dataset?.ptyRecoveryState ?? null,
        mounted: Boolean(manager),
        nullStatusEnvironments,
        connectionGeneration: statuses?.get(environmentId)?.connectionGeneration ?? null,
        remoteControlState:
          statuses?.get(environmentId)?.status?.remoteControl?.state ??
          statuses?.get(environmentId)?.remoteControl?.state ??
          null
      }
    },
    { id: webTabId, environmentId }
  )
  return { atMs: Date.now() - startedAt, ...observation }
}

async function readPaneContent(page: Page, webTabId: string): Promise<string> {
  return page.evaluate((id) => {
    const manager = window.__paneManagers?.get(id)
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    return pane?.serializeAddon?.serialize?.() ?? ''
  }, webTabId)
}

type RevealRecord = {
  timeline: PaneObservation[]
  paintedAtMs: number | null
  sawBanner: boolean
  sawNullStatus: boolean
}

/** Samples the revealed pane for `budgetMs`, stopping early once `marker` paints. */
async function recordRevealTimeline(
  page: Page,
  webTabId: string,
  environmentId: string,
  marker: string,
  budgetMs: number
): Promise<RevealRecord> {
  const startedAt = Date.now()
  const timeline: PaneObservation[] = []
  let paintedAtMs: number | null = null
  let sawBanner = false
  let sawNullStatus = false
  let previous = ''
  while (Date.now() - startedAt < budgetMs) {
    const observation = await observePane(page, webTabId, environmentId, startedAt)
    sawBanner ||= observation.banner !== null
    sawNullStatus ||= observation.nullStatusEnvironments > 0
    const key = `${observation.banner}|${observation.recoveryState}|${observation.mounted}|${observation.nullStatusEnvironments}|${observation.connectionGeneration}|${observation.remoteControlState}`
    if (key !== previous) {
      timeline.push(observation)
      previous = key
    }
    if ((await readPaneContent(page, webTabId)).includes(marker)) {
      paintedAtMs = Date.now() - startedAt
      timeline.push(await observePane(page, webTabId, environmentId, startedAt))
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return { timeline, paintedAtMs, sawBanner, sawNullStatus }
}

test('paired client tab switch does not reconnect the remote runtime', async ({
  orcaPage
}, testInfo) => {
  test.setTimeout(900_000)
  const rawOffer = await createRuntimeDesktopPairingOffer(orcaPage)
  const link = await startRuntimeEndpointLinkFault(readPairingEndpoint(rawOffer.pairingUrl))
  const offer = {
    ...rawOffer,
    pairingUrl: repointPairingUrl(rawOffer.pairingUrl, link.endpoint)
  }

  const client = await launchPairedElectronClient(offer, testInfo, 'tab-switch-reconnect', {
    extraEnv: { ORCA_E2E_TERMINAL_PARKING_DELAY_MS: String(PARK_DELAY_MS) }
  })
  const createdTerminals: string[] = []
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
        {
          timeout: 60_000,
          message: 'paired client never saw the host worktree'
        }
      )
      .toBe(true)

    const target = await createHostTerminal(client.page, client.environmentId, worktreeId)
    const decoys = [
      await createHostTerminal(client.page, client.environmentId, worktreeId),
      await createHostTerminal(client.page, client.environmentId, worktreeId)
    ]
    createdTerminals.push(target.terminal, ...decoys.map((decoy) => decoy.terminal))

    await openClientTab(client.page, worktreeId, target.webTabId)
    await expect
      .poll(() => readPaneContent(client.page, target.webTabId), {
        timeout: 60_000,
        message: 'target terminal never painted READY'
      })
      .toContain('READY')

    const censusAfterFirstOpen = await readMultiplexCensus(client.page)
    console.log(
      `[tab-switch-repro] census after first open: ${JSON.stringify(censusAfterFirstOpen)}`
    )

    // ---- Arm A: plain tab switching on a healthy link. No fault involved: if the
    // transport subscribe count climbs here, tab switching alone tears down and
    // re-establishes the environment's control channel.
    for (let round = 0; round < 3; round += 1) {
      await openClientTab(client.page, worktreeId, decoys[0].webTabId)
      await openClientTab(client.page, worktreeId, decoys[1].webTabId)
      await waitForTabParked(client.page, target.webTabId, {
        parkDelayMs: PARK_DELAY_MS
      })
      await openClientTab(client.page, worktreeId, target.webTabId)
    }
    const censusAfterHealthySwitching = await readMultiplexCensus(client.page)
    console.log(
      `[tab-switch-repro] census after healthy switching: ${JSON.stringify(censusAfterHealthySwitching)}`
    )
    console.log(
      `[tab-switch-repro] ARM A transportSubscribeCount delta over 3 healthy park/reveal rounds: ${censusAfterHealthySwitching.transportSubscribeCount - censusAfterFirstOpen.transportSubscribeCount} (unsubscribe delta ${censusAfterHealthySwitching.transportUnsubscribeCount - censusAfterFirstOpen.transportUnsubscribeCount})`
    )

    // ---- Arm B: park every terminal pane for this environment, so nothing holds
    // the multiplexed control channel open, then reveal one under a link whose
    // established flows are fine but whose new dials hang.
    // Why not a plain view switch: cold-park exempts the single most-recently-hidden
    // tab, so one pane (and its stream) keeps the multiplexer alive, and the exemption
    // migrates to a parked tab the moment the exempt one closes. So: make a decoy the
    // exempt one, park the rest, put the link into stall-new, and only then close that
    // decoy on the host (over the established control flow). The multiplexer idles out
    // and nothing can re-dial it on a healthy path before the reveal.
    await openClientTab(client.page, worktreeId, decoys[1].webTabId)
    await client.page.evaluate(() => {
      window.__store?.getState().setActiveView('changes')
    })
    await waitForTabParked(client.page, target.webTabId, { parkDelayMs: PARK_DELAY_MS })
    await waitForTabParked(client.page, decoys[0].webTabId, { parkDelayMs: PARK_DELAY_MS })
    const censusBeforeRelease = await readMultiplexCensus(client.page)
    console.log(
      `[tab-switch-repro] census with only the exempt decoy mounted: ${JSON.stringify(censusBeforeRelease)}`
    )
    link.resetCounters()
    link.setMode('stall-new')
    await callEnvironment(client.page, client.environmentId, 'terminal.closeTab', {
      terminal: decoys[1].terminal
    })
    createdTerminals.splice(createdTerminals.indexOf(decoys[1].terminal), 1)
    await expect
      .poll(async () => (await readMultiplexCensus(client.page)).transportUnsubscribeCount, {
        timeout: 30_000,
        message: 'the terminal multiplexer was never released after its last stream closed'
      })
      .toBeGreaterThan(censusBeforeRelease.transportUnsubscribeCount)
    const censusAfterFullPark = await readMultiplexCensus(client.page)
    console.log(
      `[tab-switch-repro] census after every pane parked and the multiplexer released: ${JSON.stringify(censusAfterFullPark)}`
    )
    // Setup invariant, not a claim about the bug: the reveal below has to pay a fresh
    // dial, or Arm B degrades into "reveal a tab whose transport is still up".
    expect(
      censusAfterFullPark.transportUnsubscribeCount,
      'Arm B precondition: the terminal multiplexer must have been released before the stalled reveal'
    ).toBeGreaterThan(censusBeforeRelease.transportUnsubscribeCount)

    await selectClientTab(client.page, worktreeId, target.webTabId)
    const stalled = await recordRevealTimeline(
      client.page,
      target.webTabId,
      client.environmentId,
      'READY',
      40_000
    )
    console.log(
      `[tab-switch-repro] stalled reveal: painted=${String(stalled.paintedAtMs)} banner=${stalled.sawBanner} nullStatus=${stalled.sawNullStatus} timeline=${JSON.stringify(stalled.timeline)}`
    )
    console.log(
      `[tab-switch-repro] dials at the hop: accepted=${link.acceptedConnectionCount()} stalled=${link.stalledConnectionCount()}`
    )

    // ---- Arm B2: the reporter's "reconnecting" state. Sever the established flows
    // once while new dials still hang, so the shared-control socket enters
    // `reconnecting` and the status recheck ladder arms. What the store does with
    // the resulting failed status.get is the writer under test: a live verdict must
    // not become `status: null` because the client could not ask.
    const generationBeforeFlap = (
      await observePane(client.page, target.webTabId, client.environmentId, 0)
    ).connectionGeneration
    const dropped = link.dropEstablished()
    const flapped = await recordRevealTimeline(
      client.page,
      target.webTabId,
      client.environmentId,
      'READY',
      45_000
    )
    console.log(
      `[tab-switch-repro] link flap under stall-new: dropped=${dropped} banner=${flapped.sawBanner} nullStatus=${flapped.sawNullStatus} timeline=${JSON.stringify(flapped.timeline)}`
    )

    // ---- Arm C: restore the link and measure time-to-recovery.
    link.setMode('pass')
    // Drive the documented recovery path. A pane whose attach timed out parks a retry that
    // arms no timer (#19872): it waits for online/resume/manual Reconnect, so within a bounded
    // budget the pane only comes back when one of those fires. Dispatching 'online' is exactly
    // that trigger — the same one a real network-return raises — so this arm exercises genuine
    // recovery, not the ~180s latch.
    await client.page.evaluate(() => window.dispatchEvent(new Event('online')))
    const recovered = await recordRevealTimeline(
      client.page,
      target.webTabId,
      client.environmentId,
      'READY',
      30_000
    )
    console.log(
      `[tab-switch-repro] recovery after link restored: painted=${String(recovered.paintedAtMs)} timeline=${JSON.stringify(recovered.timeline)}`
    )
    console.log(
      `[tab-switch-repro] census after recovery: ${JSON.stringify(await readMultiplexCensus(client.page))}`
    )
    console.log(`[tab-switch-repro] target sink: ${readSink(target.sinkPath).slice(0, 200)}`)
    const generationAfterRecovery = (
      await observePane(client.page, target.webTabId, client.environmentId, 0)
    ).connectionGeneration
    console.log(
      `[tab-switch-repro] connection generation across the flap: ${String(generationBeforeFlap)} -> ${String(generationAfterRecovery)}`
    )

    // Writer contract (#19647), the fix under test: a status.get that could not reach the host is
    // unverifiable, so the recorded live verdict survives the transport fault (no null published)
    // and recovery is not a second connection (the connection generation never advances). These
    // are the hard gate; both fail on the unfixed writer.
    expect(
      flapped.sawNullStatus,
      'a failed status.get over a stalled link published status: null over a live verdict (#19647)'
    ).toBe(false)
    expect(
      generationAfterRecovery,
      'recovery advanced the connection generation, so the session-tabs mirror was rebuilt (#19647)'
    ).toBe(generationBeforeFlap)
    // The fix keeps the environment revivable rather than retiring it: the pane is never disposed
    // and its host is never dropped from the mirror targets, so a later trigger can bring it back.
    const finalObservation = await observePane(
      client.page,
      target.webTabId,
      client.environmentId,
      0
    )
    expect(
      finalObservation.mounted,
      'the revealed pane was disposed instead of kept revivable'
    ).toBe(true)
    // Recovery TIMELINE is diagnostic, NOT a pass/fail gate: whether the pane actually repaints
    // within budget depends on the un-park latch (#19872) and the multiplexer cold-handshake
    // (#19871), both filed separately and out of scope here. A green run is not a clean bill of
    // health — read the [tab-switch-repro] timeline above. This value is unchanged by this PR
    // (the unfixed writer left it null too), so it is logged, not asserted.
    console.log(
      `[tab-switch-repro] recovery-contract observation (gated on #19872/#19871): painted=${String(recovered.paintedAtMs)}`
    )
  } finally {
    link.setMode('pass')
    for (const terminal of createdTerminals) {
      await callEnvironment(client.page, client.environmentId, 'terminal.closeTab', {
        terminal
      }).catch(() => undefined)
    }
    await client.dispose()
    await link.close()
  }
})
