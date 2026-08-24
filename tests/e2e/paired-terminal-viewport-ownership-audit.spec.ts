import type { Page, TestInfo } from '@stablyai/playwright-test'
import { isTerminalFocusReport } from '../../src/shared/terminal-focus-report'

import { expect, test } from './helpers/orca-app'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import { focusActiveTerminalInput } from './helpers/terminal'
import {
  callLocal,
  configureElectronWindow,
  createViewportFixture,
  createViewportTerminal,
  fitTerminalPane,
  lastFixtureGrid,
  openTerminalTab,
  readPaneGrid,
  type TerminalViewportTarget,
  waitForTerminalText
} from './helpers/terminal-viewport-ownership-fixture'
import {
  disposeTerminalWireProbe,
  installTerminalWireProbe,
  readTerminalWireProbe,
  releaseTerminalFitEvents
} from './helpers/terminal-viewport-wire-probe'

const fixture = createViewportFixture()

test.afterAll(() => fixture.dispose())

async function waitForWorktree(client: PairedElectronClient, worktreeId: string): Promise<void> {
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
      { timeout: 60_000, message: 'paired client never received the host worktree' }
    )
    .toBe(true)
}

async function focusApp(client: PairedElectronClient): Promise<void> {
  await configureElectronWindow(client.app, 1100, 720, true)
  await client.page.bringToFront()
  await expect.poll(() => client.page.evaluate(() => document.hasFocus())).toBe(true)
}

async function focusAppWithoutResize(client: PairedElectronClient): Promise<void> {
  await client.app.evaluate(({ app, BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    if (!window) {
      throw new Error('Electron window unavailable')
    }
    window.show()
    app.focus({ steal: true })
    window.focus()
  })
  await client.page.bringToFront()
  await expect.poll(() => client.page.evaluate(() => document.hasFocus())).toBe(true)
}

async function forceDocumentUnfocused(page: Page): Promise<void> {
  await page.evaluate(() => {
    Object.defineProperty(document, 'hasFocus', {
      configurable: true,
      value: () => false
    })
  })
  await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false)
}

async function restoreDocumentFocus(page: Page): Promise<void> {
  await page.evaluate(() => {
    Reflect.deleteProperty(document, 'hasFocus')
  })
}

async function typeMarker(page: Page, marker: string): Promise<void> {
  await focusActiveTerminalInput(page)
  await page.evaluate((value) => {
    const state = window.__store?.getState()
    const manager = state?.activeTabId ? window.__paneManagers?.get(state.activeTabId) : null
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0]
    if (!pane) {
      throw new Error('active terminal pane unavailable for input')
    }
    pane.terminal.input(`${value}\r`, true)
  }, marker)
}

async function waitForSink(target: TerminalViewportTarget, marker: string): Promise<string> {
  await expect
    .poll(() => fixture.readSink(target.sinkPath), {
      timeout: 30_000,
      message: `host fixture never observed ${marker}`
    })
    .toContain(marker)
  return fixture.readSink(target.sinkPath)
}

async function waitForGrid(
  target: TerminalViewportTarget,
  grid: { cols: number; rows: number }
): Promise<void> {
  const expected = clampGrid(grid)
  await expect
    .poll(() => lastFixtureGrid(fixture.readSink(target.sinkPath)), {
      timeout: 30_000,
      message: `PTY never reached ${expected.cols}x${expected.rows}`
    })
    .toEqual(expected)
}

function clampGrid(grid: { cols: number; rows: number }): { cols: number; rows: number } {
  return {
    cols: Math.max(20, Math.min(240, Math.round(grid.cols))),
    rows: Math.max(8, Math.min(120, Math.round(grid.rows)))
  }
}

function fixtureLineGrid(text: string, marker: string): { cols: number; rows: number } | null {
  const match = text.match(new RegExp(`LINE:${marker}:(\\d+)x(\\d+)`))
  return match ? { cols: Number(match[1]), rows: Number(match[2]) } : null
}

function activityOpcodes(
  frames: Awaited<ReturnType<typeof readTerminalWireProbe>>,
  streamId?: number
): number[] {
  return frames.flatMap((frame) =>
    frame.direction === 'out' &&
    (streamId === undefined || frame.streamId === streamId) &&
    frame.opcode &&
    [7, 8, 14].includes(frame.opcode) &&
    !(
      frame.opcode === 7 &&
      typeof frame.payload === 'string' &&
      isTerminalFocusReport(frame.payload)
    )
      ? [frame.opcode]
      : []
  )
}

function terminalStreamId(
  frames: Awaited<ReturnType<typeof readTerminalWireProbe>>,
  terminal: string
): number {
  for (const frame of frames) {
    const payload = frame.payload as { streamId?: unknown; terminal?: unknown } | undefined
    if (
      frame.direction === 'out' &&
      frame.opcode === 9 &&
      payload?.terminal === terminal &&
      typeof payload.streamId === 'number'
    ) {
      return payload.streamId
    }
  }
  throw new Error(`terminal stream unavailable for ${terminal}`)
}

async function runtimeTail(page: Page, terminal: string): Promise<string> {
  const result = await callLocal<{ terminal: { tail: string[] } }>(page, 'terminal.read', {
    terminal
  })
  return result.terminal.tail.join('\n')
}

async function captureVersions(hostPage: Page, clients: PairedElectronClient[]): Promise<unknown> {
  const hostStatus = await callLocal<{
    appVersion?: string
    capabilities?: string[]
  }>(hostPage, 'status.get', {})
  const clientVersions = await Promise.all(
    clients.map((client) => client.app.evaluate(({ app }) => app.getVersion()))
  )
  return { clientVersions, hostStatus }
}

async function screenshotTopology(
  testInfo: TestInfo,
  hostPage: Page,
  clients: PairedElectronClient[]
): Promise<void> {
  await hostPage.screenshot({ path: testInfo.outputPath('sta5050-host.png') })
  await clients[0]?.page.screenshot({ path: testInfo.outputPath('sta5050-client-a.png') })
  await clients[1]?.page.screenshot({ path: testInfo.outputPath('sta5050-client-b.png') })
}

test('current clients keep viewport ownership with real activity @headful', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  test.setTimeout(300_000)
  const worktreeId = await orcaPage.evaluate(() => window.__store?.getState().activeWorktreeId)
  if (!worktreeId) {
    throw new Error('headed host has no active worktree')
  }
  const createdClients: PairedElectronClient[] = []
  let target: TerminalViewportTarget | null = null
  let clientA: PairedElectronClient | null = null
  let clientB: PairedElectronClient | null = null
  try {
    clientA = await launchPairedElectronClient(
      await createRuntimeDesktopPairingOffer(orcaPage),
      testInfo,
      'STA-5050 active client A'
    )
    createdClients.push(clientA)
    await waitForWorktree(clientA, worktreeId)
    target = await createViewportTerminal(clientA.page, clientA.environmentId, worktreeId, fixture)
    await configureElectronWindow(electronApp, 1500, 900, true)
    await openTerminalTab(orcaPage, worktreeId, target.hostTabId)
    await waitForSink(target, 'READY:')
    const hostGrid = await readPaneGrid(orcaPage, target.hostTabId)
    await configureElectronWindow(clientA.app, 1120, 720, true)
    await installTerminalWireProbe(clientA.app)
    await openTerminalTab(clientA.page, worktreeId, target.webTabId)
    await expect
      .poll(() => readTerminalWireProbe(clientA!.app), { timeout: 30_000 })
      .toEqual(expect.arrayContaining([expect.objectContaining({ direction: 'out', opcode: 9 })]))
    const clientAStreamId = terminalStreamId(
      await readTerminalWireProbe(clientA.app),
      target.terminal
    )
    await focusApp(clientA)
    await typeMarker(clientA.page, 'A_OWNER')
    await waitForSink(target, 'LINE:A_OWNER:')
    const clientAGrid = await readPaneGrid(clientA.page, target.webTabId)
    await waitForGrid(target, clientAGrid)
    const previewWireStart = (await readTerminalWireProbe(clientA.app)).length
    const passivePreview = await orcaPage.evaluate(async (hostTabId) => {
      const ptyId = window.__store?.getState().ptyIdsByTabId[hostTabId]?.[0]
      if (!ptyId) {
        throw new Error(`host PTY unavailable for ${hostTabId}`)
      }
      const connection = await window.api.terminalPreview.connect(ptyId, { scrollbackRows: 24 })
      await window.api.terminalPreview.unsubscribe(ptyId)
      return {
        ptyId,
        snapshotCols: connection.snapshot?.cols,
        snapshotRows: connection.snapshot?.rows
      }
    }, target.hostTabId)
    const passivePreviewFrames = (await readTerminalWireProbe(clientA.app)).slice(previewWireStart)
    const passivePreviewGrid = lastFixtureGrid(fixture.readSink(target.sinkPath))
    expect(activityOpcodes(passivePreviewFrames, clientAStreamId)).toEqual([])
    expect(passivePreviewGrid).toEqual(clientAGrid)

    clientB = await launchPairedElectronClient(
      await createRuntimeDesktopPairingOffer(orcaPage),
      testInfo,
      'STA-5050 passive client B'
    )
    createdClients.push(clientB)
    await waitForWorktree(clientB, worktreeId)
    await configureElectronWindow(clientB.app, 760, 520, false)
    await installTerminalWireProbe(clientB.app, { holdFitEvents: true })
    await focusApp(clientA)
    await openTerminalTab(clientB.page, worktreeId, target.webTabId)
    await waitForTerminalText(clientB.page, target.webTabId, 'READY:')
    await expect
      .poll(() => readTerminalWireProbe(clientB!.app))
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            direction: 'out',
            opcode: 9,
            payload: expect.objectContaining({
              capabilities: expect.objectContaining({ desktopViewportClaims: 1 })
            })
          })
        ])
      )
    const clientBStreamId = terminalStreamId(
      await readTerminalWireProbe(clientB.app),
      target.terminal
    )
    await configureElectronWindow(clientB.app, 760, 520, false)
    await focusApp(clientA)
    await forceDocumentUnfocused(clientB.page)
    const passiveAttachGrid = lastFixtureGrid(fixture.readSink(target.sinkPath))
    const unfocusedVisible = await clientB.page.evaluate(() => ({
      focused: document.hasFocus(),
      visibility: document.visibilityState
    }))
    expect(unfocusedVisible).toEqual({ focused: false, visibility: 'visible' })

    const passiveResizeStart = (await readTerminalWireProbe(clientB.app)).length
    await configureElectronWindow(clientB.app, 700, 480, false)
    await focusApp(clientA)
    await expect.poll(() => clientB!.page.evaluate(() => document.hasFocus())).toBe(false)
    await fitTerminalPane(clientB.page, target.webTabId)
    await expect
      .poll(
        () =>
          readTerminalWireProbe(clientB!.app).then((frames) => frames.slice(passiveResizeStart)),
        {
          timeout: 30_000
        }
      )
      .toEqual(expect.arrayContaining([expect.objectContaining({ direction: 'out', opcode: 8 })]))
    const clientBGrid = clampGrid(await readPaneGrid(clientB.page, target.webTabId))
    await typeMarker(clientA.page, 'A_PASSIVE_BARRIER')
    await waitForSink(target, 'LINE:A_PASSIVE_BARRIER:')
    const raceGrid = lastFixtureGrid(fixture.readSink(target.sinkPath))
    const runtimeRaceTail = await runtimeTail(orcaPage, target.terminal)
    const passiveResizeFrames = (await readTerminalWireProbe(clientB.app)).slice(passiveResizeStart)
    expect(activityOpcodes(passiveResizeFrames, clientBStreamId)).not.toContain(14)
    expect(raceGrid).toEqual(clientAGrid)

    await restoreDocumentFocus(clientB.page)
    await focusAppWithoutResize(clientB)
    const clientBInputGrid = clampGrid(await readPaneGrid(clientB.page, target.webTabId))
    expect(clientBInputGrid).not.toEqual(clientAGrid)
    expect(clientBInputGrid).not.toEqual(hostGrid)
    expect(clientAGrid).not.toEqual(hostGrid)
    const clientBInputStart = (await readTerminalWireProbe(clientB.app)).length
    expect(lastFixtureGrid(fixture.readSink(target.sinkPath))).toEqual(clientAGrid)
    await typeMarker(clientB.page, 'B_PRE_FIT_INPUT')
    await waitForSink(target, 'LINE:B_PRE_FIT_INPUT:')
    const clientBInputFrames = (await readTerminalWireProbe(clientB.app)).slice(clientBInputStart)
    expect({
      lineGrid: fixtureLineGrid(fixture.readSink(target.sinkPath), 'B_PRE_FIT_INPUT'),
      opcodes: activityOpcodes(clientBInputFrames, clientBStreamId).slice(-3)
    }).toEqual({ lineGrid: clientBInputGrid, opcodes: [14, 8, 7] })
    await waitForGrid(target, clientBInputGrid)

    await releaseTerminalFitEvents(clientB.app)
    await focusApp(clientA)
    const clientAInputStart = (await readTerminalWireProbe(clientA.app)).length
    expect(lastFixtureGrid(fixture.readSink(target.sinkPath))).toEqual(clientBInputGrid)
    await typeMarker(clientA.page, 'A_RECLAIM')
    await waitForSink(target, 'LINE:A_RECLAIM:')
    await waitForGrid(target, clientAGrid)
    const clientAInputFrames = (await readTerminalWireProbe(clientA.app)).slice(clientAInputStart)
    expect(activityOpcodes(clientAInputFrames, clientAStreamId).slice(-3)).toEqual([14, 8, 7])
    expect(fixtureLineGrid(fixture.readSink(target.sinkPath), 'A_RECLAIM')).toEqual(clientAGrid)
    await expect
      .poll(
        () =>
          readTerminalWireProbe(clientA!.app).then((frames) =>
            frames
              .slice(clientAInputStart)
              .some(
                (frame) =>
                  frame.direction === 'in' &&
                  JSON.stringify(frame.payload).includes('"mode":"desktop-fit"')
              )
          ),
        { timeout: 30_000 }
      )
      .toBe(true)
    await clientA.page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    )
    const clientASteadyInputStart = (await readTerminalWireProbe(clientA.app)).length
    await typeMarker(clientA.page, 'A_STEADY_INPUT')
    await waitForSink(target, 'LINE:A_STEADY_INPUT:')
    const clientASteadyInputFrames = (await readTerminalWireProbe(clientA.app)).slice(
      clientASteadyInputStart
    )
    expect(activityOpcodes(clientASteadyInputFrames, clientAStreamId)).toEqual([7])
    expect(fixtureLineGrid(fixture.readSink(target.sinkPath), 'A_STEADY_INPUT')).toEqual(
      clientAGrid
    )

    const claimsBeforeBackgroundResize = (await readTerminalWireProbe(clientB.app)).filter(
      (frame) => frame.streamId === clientBStreamId && frame.opcode === 14
    ).length
    await forceDocumentUnfocused(clientB.page)
    const backgroundResizeStart = (await readTerminalWireProbe(clientB.app)).length
    await configureElectronWindow(clientB.app, 660, 460, false)
    await focusApp(clientA)
    await expect.poll(() => clientB!.page.evaluate(() => document.hasFocus())).toBe(false)
    await fitTerminalPane(clientB.page, target.webTabId)
    await expect
      .poll(
        () =>
          readTerminalWireProbe(clientB!.app).then((frames) => frames.slice(backgroundResizeStart)),
        { timeout: 30_000 }
      )
      .toEqual(expect.arrayContaining([expect.objectContaining({ direction: 'out', opcode: 8 })]))
    const backgroundClientBGrid = clampGrid(await readPaneGrid(clientB.page, target.webTabId))
    await typeMarker(clientA.page, 'A_BACKGROUND_BARRIER')
    await waitForSink(target, 'LINE:A_BACKGROUND_BARRIER:')
    const finalWireTrace = await readTerminalWireProbe(clientB.app)
    const claimsAfterBackgroundResize = finalWireTrace.filter(
      (frame) => frame.streamId === clientBStreamId && frame.opcode === 14
    ).length
    const backgroundGrid = lastFixtureGrid(fixture.readSink(target.sinkPath))

    await configureElectronWindow(electronApp, 1500, 900, true)
    await orcaPage.bringToFront()
    expect(lastFixtureGrid(fixture.readSink(target.sinkPath))).toEqual(clientAGrid)
    await typeMarker(orcaPage, 'HOST_RECLAIM')
    await waitForSink(target, 'LINE:HOST_RECLAIM:')
    expect(fixtureLineGrid(fixture.readSink(target.sinkPath), 'HOST_RECLAIM')).toEqual(hostGrid)
    await waitForGrid(target, hostGrid)

    await focusApp(clientA)
    expect(lastFixtureGrid(fixture.readSink(target.sinkPath))).toEqual(hostGrid)
    await typeMarker(clientA.page, 'A_DETACH_OWNER')
    await waitForSink(target, 'LINE:A_DETACH_OWNER:')
    await waitForGrid(target, clientAGrid)
    await screenshotTopology(testInfo, orcaPage, [clientA, clientB])
    const versions = await captureVersions(orcaPage, [clientA, clientB])
    await disposeTerminalWireProbe(clientB.app)
    await clientA.dispose()
    createdClients.splice(createdClients.indexOf(clientA), 1)
    clientA = null
    await waitForGrid(target, backgroundClientBGrid)
    const fallbackGrid = lastFixtureGrid(fixture.readSink(target.sinkPath))
    await clientB.dispose()
    createdClients.splice(createdClients.indexOf(clientB), 1)
    clientB = null
    await waitForGrid(target, hostGrid)
    const detachGrid = lastFixtureGrid(fixture.readSink(target.sinkPath))

    const evidence = {
      backgroundClientBGrid,
      backgroundGrid,
      claimsAfterBackgroundResize,
      claimsBeforeBackgroundResize,
      clientAInputFrames,
      clientASteadyInputFrames,
      clientAGrid,
      clientBGrid,
      clientBInputFrames,
      clientBInputGrid,
      detachGrid,
      fallbackGrid,
      hostGrid,
      passiveAttachGrid,
      passivePreview,
      passivePreviewGrid,
      raceGrid,
      runtimeRaceTailHasGrid: runtimeRaceTail.includes(
        `SIZE:${clientBGrid.cols}x${clientBGrid.rows}`
      ),
      unfocusedVisible,
      versions,
      wireFrames: finalWireTrace.filter(
        (frame) => frame.streamId === clientBStreamId && (frame.opcode === 8 || frame.opcode === 14)
      )
    }
    console.log(`[sta5050-current] ${JSON.stringify(evidence)}`)
    expect(evidence).toMatchObject({
      backgroundGrid: clientAGrid,
      claimsAfterBackgroundResize: claimsBeforeBackgroundResize,
      detachGrid: hostGrid,
      fallbackGrid: backgroundClientBGrid,
      passiveAttachGrid: clientAGrid,
      passivePreviewGrid: clientAGrid,
      raceGrid: clientAGrid,
      runtimeRaceTailHasGrid: false,
      unfocusedVisible: { focused: false, visibility: 'visible' }
    })
  } finally {
    if (clientB) {
      await disposeTerminalWireProbe(clientB.app).catch(() => undefined)
    }
    if (clientA) {
      await disposeTerminalWireProbe(clientA.app).catch(() => undefined)
    }
    for (const client of createdClients.toReversed()) {
      await client.dispose().catch(() => undefined)
    }
    if (target) {
      await callLocal(orcaPage, 'terminal.closeTab', { terminal: target.terminal }).catch(
        () => undefined
      )
    }
  }
})

test('host input reclaims before delayed renderer fit state @headful', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  test.setTimeout(180_000)
  const worktreeId = await orcaPage.evaluate(() => window.__store?.getState().activeWorktreeId)
  if (!worktreeId) {
    throw new Error('headed host has no active worktree')
  }
  let target: TerminalViewportTarget | null = null
  let client: PairedElectronClient | null = null
  try {
    client = await launchPairedElectronClient(
      await createRuntimeDesktopPairingOffer(orcaPage),
      testInfo,
      'STA-5050 remote owner'
    )
    await waitForWorktree(client, worktreeId)
    target = await createViewportTerminal(client.page, client.environmentId, worktreeId, fixture)
    await configureElectronWindow(electronApp, 1500, 900, true)
    await openTerminalTab(orcaPage, worktreeId, target.hostTabId)
    await waitForSink(target, 'READY:')
    const hostGrid = await readPaneGrid(orcaPage, target.hostTabId)
    await configureElectronWindow(client.app, 700, 480, false)
    await installTerminalWireProbe(electronApp, {
      dropHostViewportClaims: true,
      holdHostFitEvents: true
    })
    await configureElectronWindow(electronApp, 1500, 900, true)
    await orcaPage.bringToFront()
    await openTerminalTab(client.page, worktreeId, target.webTabId)
    await waitForTerminalText(client.page, target.webTabId, 'READY:')
    await focusAppWithoutResize(client)
    await fitTerminalPane(client.page, target.webTabId)
    const clientGrid = clampGrid(await readPaneGrid(client.page, target.webTabId))
    await waitForGrid(target, clientGrid)
    await typeMarker(client.page, 'REMOTE_OWNER')
    await waitForSink(target, 'LINE:REMOTE_OWNER:')
    expect(fixtureLineGrid(fixture.readSink(target.sinkPath), 'REMOTE_OWNER')).toEqual(clientGrid)
    expect(clientGrid).not.toEqual(hostGrid)
    await expect
      .poll(() => readTerminalWireProbe(electronApp), { timeout: 30_000 })
      .toEqual(expect.arrayContaining([expect.objectContaining({ direction: 'in', held: true })]))

    await forceDocumentUnfocused(orcaPage)
    const hostLayoutStart = (await readTerminalWireProbe(electronApp)).length
    await fitTerminalPane(orcaPage, target.hostTabId)
    await typeMarker(client.page, 'REMOTE_HOST_LAYOUT_BARRIER')
    await waitForSink(target, 'LINE:REMOTE_HOST_LAYOUT_BARRIER:')
    expect(
      fixtureLineGrid(fixture.readSink(target.sinkPath), 'REMOTE_HOST_LAYOUT_BARRIER')
    ).toEqual(clientGrid)
    const hostLayoutFrames = (await readTerminalWireProbe(electronApp)).slice(hostLayoutStart)
    expect(activityOpcodes(hostLayoutFrames)).not.toContain(14)

    await restoreDocumentFocus(orcaPage)
    await configureElectronWindow(electronApp, 1500, 900, true)
    await orcaPage.bringToFront()
    await typeMarker(orcaPage, 'HOST_PRE_FIT_INPUT')
    await waitForSink(target, 'LINE:HOST_PRE_FIT_INPUT:')
    expect(fixtureLineGrid(fixture.readSink(target.sinkPath), 'HOST_PRE_FIT_INPUT')).toEqual(
      hostGrid
    )
    await waitForGrid(target, hostGrid)
  } finally {
    await disposeTerminalWireProbe(electronApp).catch(() => undefined)
    await client?.dispose().catch(() => undefined)
    if (target) {
      await callLocal(orcaPage, 'terminal.closeTab', { terminal: target.terminal }).catch(
        () => undefined
      )
    }
  }
})

test('legacy clients retain resize-as-activity compatibility @headful', async ({
  orcaPage
}, testInfo) => {
  test.setTimeout(240_000)
  const worktreeId = await orcaPage.evaluate(() => window.__store?.getState().activeWorktreeId)
  if (!worktreeId) {
    throw new Error('headed host has no active worktree')
  }
  let target: TerminalViewportTarget | null = null
  let active: PairedElectronClient | null = null
  let legacy: PairedElectronClient | null = null
  try {
    active = await launchPairedElectronClient(
      await createRuntimeDesktopPairingOffer(orcaPage),
      testInfo,
      'STA-5050 current owner'
    )
    await waitForWorktree(active, worktreeId)
    target = await createViewportTerminal(active.page, active.environmentId, worktreeId, fixture)
    await openTerminalTab(active.page, worktreeId, target.webTabId)
    await focusApp(active)
    await typeMarker(active.page, 'CURRENT_OWNER')
    const activeGrid = await readPaneGrid(active.page, target.webTabId)
    await waitForGrid(target, activeGrid)

    legacy = await launchPairedElectronClient(
      await createRuntimeDesktopPairingOffer(orcaPage),
      testInfo,
      'STA-5050 legacy observer'
    )
    await waitForWorktree(legacy, worktreeId)
    await configureElectronWindow(legacy.app, 700, 480, false)
    await installTerminalWireProbe(legacy.app, { legacyViewportClient: true })
    await focusApp(active)
    await openTerminalTab(legacy.page, worktreeId, target.webTabId)
    await waitForGrid(target, clampGrid(await readPaneGrid(legacy.page, target.webTabId)))
    const legacyStreamId = terminalStreamId(
      await readTerminalWireProbe(legacy.app),
      target.terminal
    )
    const legacyResizeStart = (await readTerminalWireProbe(legacy.app)).length
    await configureElectronWindow(legacy.app, 660, 460, false)
    await fitTerminalPane(legacy.page, target.webTabId)
    const legacyGrid = clampGrid(await readPaneGrid(legacy.page, target.webTabId))
    await expect
      .poll(
        () => readTerminalWireProbe(legacy!.app).then((frames) => frames.slice(legacyResizeStart)),
        { timeout: 30_000 }
      )
      .toEqual(expect.arrayContaining([expect.objectContaining({ direction: 'out', opcode: 8 })]))
    await waitForGrid(target, legacyGrid)
    const trace = await readTerminalWireProbe(legacy.app)
    const outgoingFrames = trace.filter((frame) => {
      if (frame.direction !== 'out') {
        return false
      }
      const payload = frame.payload as { terminal?: unknown } | undefined
      return (
        frame.streamId === legacyStreamId ||
        (frame.opcode === 9 && payload?.terminal === target!.terminal)
      )
    })
    console.log(
      `[sta5050-legacy] ${JSON.stringify({ activeGrid, legacyGrid, trace: outgoingFrames })}`
    )
    expect(lastFixtureGrid(fixture.readSink(target.sinkPath))).toEqual(legacyGrid)
    expect(outgoingFrames.some((frame) => frame.opcode === 14)).toBe(false)
    expect(outgoingFrames.some((frame) => frame.originalOpcode === 14 && frame.opcode === 8)).toBe(
      true
    )
    expect(JSON.stringify(outgoingFrames)).not.toContain('desktopViewportClaims')
  } finally {
    if (legacy) {
      await disposeTerminalWireProbe(legacy.app).catch(() => undefined)
    }
    await legacy?.dispose().catch(() => undefined)
    await active?.dispose().catch(() => undefined)
    if (target) {
      await callLocal(orcaPage, 'terminal.closeTab', { terminal: target.terminal }).catch(
        () => undefined
      )
    }
  }
})
