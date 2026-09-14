/**
 * STA-2854 live validation: a HOST pane that cold-parks while a paired client
 * is actively viewing it must keep serving that client.
 *
 * Topology: headed Orca desktop host (remote server) + a separate paired Orca
 * desktop client. The reported shape is the inverse of every existing paired
 * parking spec: those park on the CLIENT, this parks on the HOST while the
 * client watches. The host user never touches the tab again after parking it.
 *
 * Two independent signals, as required for an end-to-end claim:
 *   1. host-side: the fixture process's own sink file records the typed line —
 *      the bytes reached the authoritative host PTY;
 *   2. client-side: the client's xterm paints the echo — output crossed back.
 * Plus PTY identity: the sink must still hold exactly one READY line, so the
 * park never respawned or replaced the process.
 *
 * Before the fix, `H±` = host pane mounted, phase = client transport, 2s samples:
 *   H-/recovering x8  ->  H-/connected x37,  input-reached=false
 * The host park dropped the paired client into the "Reconnecting to remote
 * runtime" state for ~16s; it reconnected on its own, but the line typed at
 * park time was silently discarded forever by recoveryBlocksIo(). Reproduced
 * identically at the production 30s cold-park hysteresis, so the shortened test
 * override was not the cause.
 *
 * After the fix (parked panes keep publishing their runtime-graph leaf):
 *   H-/connected x45,  the typed line reaches the host PTY AND its echo paints
 *   back in the client's own xterm within one 2s sample.
 *
 * Run:
 *   pnpm exec playwright test tests/e2e/host-parked-pane-remote-viewer.spec.ts \
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
import { focusActiveTerminalInput } from './helpers/terminal'
import { waitForTabParked } from './helpers/terminal-hidden-parking'

const PARK_DELAY_MS = 30_000
const PAINT_BUDGET_MS = 20_000
const scratch = mkdtempSync(path.join(os.tmpdir(), 'orca-host-park-viewer-'))
const fixturePath = path.join(scratch, 'host-park-viewer-terminal.mjs')
writeFileSync(
  fixturePath,
  [
    "import { appendFileSync } from 'node:fs'",
    'const sink = process.argv[2]',
    'const record = (line) => appendFileSync(sink, `${line}\\n`)',
    'record(`READY:${process.pid}`)',
    'process.stdout.write(`READY:${process.pid}\\r\\n`)',
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

// Why: the HOST must park quickly too, so its launch env carries the override.
test.use({ orcaAppExtraEnv: { ORCA_E2E_TERMINAL_PARKING_DELAY_MS: String(PARK_DELAY_MS) } })

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

async function readPaneContent(page: Page, tabId: string): Promise<string> {
  return page.evaluate((id) => {
    const manager = window.__paneManagers?.get(id)
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    return pane?.serializeAddon?.serialize?.() ?? ''
  }, tabId)
}

async function waitForPaneMarker(
  page: Page,
  tabId: string,
  marker: string,
  budgetMs: number
): Promise<boolean> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if ((await readPaneContent(page, tabId)).includes(marker)) {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return false
}

test('a cold-parked host pane keeps serving its paired remote viewer', async ({
  orcaPage
}, testInfo) => {
  test.setTimeout(600_000)
  const offer = await createRuntimeDesktopPairingOffer(orcaPage)
  const previousParkDelay = process.env.ORCA_E2E_TERMINAL_PARKING_DELAY_MS
  process.env.ORCA_E2E_TERMINAL_PARKING_DELAY_MS = String(PARK_DELAY_MS)
  const client = await launchPairedElectronClient(offer, testInfo, 'host-park-viewer')
  const createdTerminals: string[] = []
  const sinkPath = path.join(scratch, `sink-${randomUUID()}.log`)
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

    // Host-owned terminal, created through the host runtime.
    const created = await callEnvironment<{ tab: { id: string; terminal: string | null } }>(
      client.page,
      client.environmentId,
      'session.tabs.createTerminal',
      {
        worktree: `id:${worktreeId}`,
        command: fixtureCommand(sinkPath),
        activate: false,
        select: false,
        navigation: 'caller'
      }
    )
    if (!created.tab.terminal) {
      throw new Error('host session terminal was not created')
    }
    createdTerminals.push(created.tab.terminal)
    const hostTabId = created.tab.id.split(HOST_TERMINAL_SURFACE_SEPARATOR)[0]
    const webTabId = toWebTerminalSurfaceTabId(hostTabId)

    // 1. Host mounts the pane (the ordinary "someone looked at it" state).
    await orcaPage.evaluate(
      ({ worktreeId, tabId }) => {
        const state = window.__store?.getState()
        state?.setActiveView('terminal')
        state?.setActiveWorktree(worktreeId)
        state?.setActiveTab(tabId)
        state?.setActiveTabType('terminal')
      },
      { worktreeId, tabId: hostTabId }
    )
    await expect
      .poll(() => orcaPage.evaluate((id) => window.__paneManagers?.has(id) ?? false, hostTabId), {
        timeout: 60_000,
        message: 'host never mounted its own terminal pane'
      })
      .toBe(true)

    // 2. Client subscribes and is actively viewing it.
    await expect
      .poll(
        () =>
          client.page.evaluate(
            (id) => (window.__store?.getState().tabsByWorktree[id] ?? []).map((tab) => tab.id),
            worktreeId
          ),
        { timeout: 60_000, message: 'client never mirrored the host tab' }
      )
      .toContain(webTabId)
    await client.page.evaluate(
      ({ webTabId, worktreeId }) => {
        const state = window.__store?.getState()
        state?.setActiveView('terminal')
        state?.setActiveWorktree(worktreeId)
        state?.setActiveTab(webTabId)
        state?.setActiveTabType('terminal')
      },
      { webTabId, worktreeId }
    )
    expect(
      await waitForPaneMarker(client.page, webTabId, 'READY:', PAINT_BUDGET_MS),
      'client never painted the host terminal before the host parked it'
    ).toBe(true)

    // 2b. CONTROL: the same typed path must work BEFORE the host parks. Without
    //     this, a focus/keyboard artifact would masquerade as the park bug.
    const controlToken = `sta2854-control-${randomUUID().slice(0, 8)}`
    await focusActiveTerminalInput(client.page)
    await client.page.keyboard.type(controlToken)
    await client.page.keyboard.press('Enter')
    const controlReached = await (async () => {
      const deadline = Date.now() + PAINT_BUDGET_MS
      while (Date.now() < deadline) {
        if (readSink(sinkPath).includes(`LINE:${controlToken}`)) {
          return true
        }
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      return false
    })()
    console.log(
      `[sta2854] control-reached=${controlReached} sink=${JSON.stringify(readSink(sinkPath))}`
    )
    expect(
      controlReached,
      'control: client input did not reach the host PTY even before any park'
    ).toBe(true)

    // 3. The host cold-parks the pane the client is watching. Nobody touches
    //    it on the host again.
    // Two decoy tabs on the host: one to age the target, one to take the
    // most-recently-hidden exemption. Sampled before and after the park lands
    // so decoy churn cannot be mistaken for the park itself.
    for (let i = 0; i < 2; i += 1) {
      await orcaPage.evaluate((id) => {
        const state = window.__store?.getState()
        const tab = state?.createTab(id, undefined, undefined, { activate: true })
        if (tab) {
          state?.setActiveTab(tab.id)
          state?.setActiveTabType('terminal')
        }
      }, worktreeId)
    }
    const readClientState = async (): Promise<unknown> =>
      client.page.evaluate((id) => {
        const manager = window.__paneManagers?.get(id)
        const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
        return {
          mounted: Boolean(manager),
          ptyId: pane?.container?.dataset?.ptyId ?? null,
          recoveryState: pane?.container?.dataset?.ptyRecoveryState ?? null
        }
      }, webTabId)
    console.log(`[sta2854] decoys-created client=${JSON.stringify(await readClientState())}`)
    await waitForTabParked(orcaPage, hostTabId, { parkDelayMs: PARK_DELAY_MS })
    console.log(`[sta2854] post-park client=${JSON.stringify(await readClientState())}`)

    // Direct probe: is the host-minted terminal handle still resolvable once
    // its pane is parked? (It is — so the boundary is not handle liveness.)
    const handleProbe = await client.page.evaluate(
      async ({ environmentId, terminal }) => {
        const response = await window.api.runtimeEnvironments.call({
          selector: environmentId,
          method: 'terminal.read',
          params: { terminal }
        })
        return response.ok
          ? { ok: true as const }
          : { ok: false as const, code: response.error.code, message: response.error.message }
      },
      { environmentId: client.environmentId, terminal: created.tab.terminal }
    )
    console.log(`[sta2854] handle-probe=${JSON.stringify(handleProbe)}`)

    // Type the moment the host parks — a user driving the pane does not wait
    // for a banner. Input accepted here must reach the host PTY.
    const token = `sta2854-${randomUUID().slice(0, 8)}`
    await focusActiveTerminalInput(client.page)
    await client.page.keyboard.type(token)
    await client.page.keyboard.press('Enter')

    // Timeline: host pane mount state vs client transport phase. Long enough to
    // catch a second park cycle if the recovery remounts the host pane.
    const timeline: string[] = []
    const timelineDeadline = Date.now() + 90_000
    let inputReached = false
    let clientEchoed = false
    while (Date.now() < timelineDeadline) {
      const hostMounted = await orcaPage.evaluate(
        (id) => window.__paneManagers?.has(id) ?? false,
        hostTabId
      )
      const clientPhase = await client.page.evaluate((id) => {
        const manager = window.__paneManagers?.get(id)
        const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
        return pane?.container?.dataset?.ptyRecoveryState ?? 'unmounted'
      }, webTabId)
      inputReached ||= readSink(sinkPath).includes(`LINE:${token}`)
      // Signal 2, and the reason this is not merely a host-side test: the echo
      // has to come back out to the client's own xterm.
      clientEchoed ||= (await readPaneContent(client.page, webTabId)).includes(`LINE:${token}`)
      timeline.push(
        `${hostMounted ? 'H+' : 'H-'}/${clientPhase}${inputReached ? '/in' : ''}${clientEchoed ? '/echo' : ''}`
      )
      await new Promise((resolve) => setTimeout(resolve, 2_000))
    }
    console.log(`[sta2854] timeline=${JSON.stringify(timeline)}`)
    console.log(
      `[sta2854] input-reached=${inputReached} client-echoed=${clientEchoed} sink=${JSON.stringify(readSink(sinkPath))}`
    )

    const disruptedSamples = timeline.filter((entry) => !entry.includes('/connected'))
    expect(
      { disrupted: disruptedSamples.length, timeline },
      'host-local cold parking disrupted the paired client transport'
    ).toEqual({ disrupted: 0, timeline })
    expect(
      { inputReached, clientEchoed },
      'the parked host pane did not carry a full round trip for its remote viewer'
    ).toEqual({ inputReached: true, clientEchoed: true })

    // 5. PTY identity: one process, never respawned across the park.
    const readyLines = readSink(sinkPath)
      .split('\n')
      .filter((line) => line.startsWith('READY:'))
    expect(readyLines, 'host PTY was replaced across the park').toHaveLength(1)
    // Intentionally not asserted: whether the host pane stays parked is part of
    // what the timeline above reports (a recovery-driven remount would show as
    // H+ samples), not a precondition of the invariant.
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
