import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  expect,
  test,
  type ElectronApplication,
  type Page,
  type TestInfo
} from '@stablyai/playwright-test'
import {
  installRemoteTerminalGeometryProbe,
  readRemoteTerminalGeometryProbe
} from './helpers/remote-terminal-geometry-probe'
import { toWebTerminalSurfaceTabId } from '../../src/shared/terminal-surface-id'
import { toRemoteRuntimePtyId } from '../../src/shared/remote-runtime-pty-id'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import { launchPairedElectronClient } from './helpers/paired-electron-client'
import { cleanupE2EDaemons } from './helpers/electron-process-shutdown'
import {
  createHostCliTerminal,
  readSink,
  type RuntimeRpcCall
} from './helpers/host-created-terminal-retention-oracle'

type TerminalSummary = {
  handle: string
  ptyId: string
  incarnationId: string
  title?: string | null
  agentIdentity?: string
}

type HostSessionTab = {
  title?: string
  agentStatus?: { agentType?: string }
}

async function verifyReleaseBuild(app: ElectronApplication) {
  const observed = await app.evaluate(({ app }) => ({
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    userDataDir: app.getPath('userData')
  }))
  const manifest = JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'))
  const electronManifest = JSON.parse(
    readFileSync(path.join(process.cwd(), 'node_modules', 'electron', 'package.json'), 'utf8')
  )
  expect(observed.appVersion).toBe(manifest.version)
  expect(observed.electronVersion).toBe(electronManifest.version)
  return observed
}

async function captureHiddenRenderer(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const cdp = await page.context().newCDPSession(page)
  try {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
    const screenshot = testInfo.outputPath(`${name}.png`)
    writeFileSync(screenshot, Buffer.from(data, 'base64'))
    await testInfo.attach(name, { path: screenshot, contentType: 'image/png' })
  } finally {
    await cdp.detach()
  }
}

async function inspectPane(page: Page, tabId: string) {
  return page.evaluate((id) => {
    const manager = window.__paneManagers?.get(id)
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0]
    if (!pane) {
      return null
    }
    const terminal = pane.terminal
    const buffer = terminal.buffer.active
    let text = ''
    let invisibleCharacters = 0
    for (let y = 0; y < buffer.length; y++) {
      const line = buffer.getLine(y)
      text += `${y > 0 && !line?.isWrapped ? '\n' : ''}${line?.translateToString(true) ?? ''}`
      for (let x = 0; x < terminal.cols; x++) {
        const cell = line?.getCell(x)
        if (cell?.getChars().trim() && cell.isInvisible()) {
          invisibleCharacters++
        }
      }
    }
    const prior = Reflect.get(window, '__replacementOriginalTerminal')
    const state = window.__store?.getState()
    return {
      sameTerminal: terminal === prior,
      mouseMode: terminal.modes.mouseTrackingMode,
      bufferType: buffer.type,
      viewportY: buffer.viewportY,
      baseY: buffer.baseY,
      text,
      cols: terminal.cols,
      rows: terminal.rows,
      proposedGrid: pane.fitAddon.proposeDimensions(),
      documentVisibility: document.visibilityState,
      containerSize: {
        width: pane.container.getBoundingClientRect().width,
        height: pane.container.getBoundingClientRect().height
      },
      agentStates: Object.values(state?.agentStatusByPaneKey ?? {}).map((entry) => ({
        agentType: entry.agentType,
        state: entry.state,
        terminalTitle: entry.terminalTitle
      })),
      invisibleCharacters,
      title: state?.tabsByWorktree[state.activeWorktreeId ?? '']?.find((tab) => tab.id === id)
        ?.title,
      ptyId: pane.container.dataset.ptyId,
      recoveryPhase: pane.container.dataset.ptyRecoveryState
    }
  }, tabId)
}

async function probeMouse(page: Page, tabId: string) {
  return page.evaluate(async (id) => {
    const manager = window.__paneManagers?.get(id)
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0]
    const screen = pane?.terminal.element?.querySelector('.xterm-screen')
    if (!pane || !screen) {
      throw new Error('No rendered terminal for mouse probe')
    }
    const terminal = pane.terminal
    const reports: string[] = []
    const listener = terminal.onData((data) => {
      if (data.includes('\x1b[<')) {
        reports.push(data)
      }
    })
    const before = terminal.buffer.active.viewportY
    try {
      const rect = screen.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) {
        throw new Error('Terminal has no layout')
      }
      for (const fraction of [0.2, 0.4, 0.6, 0.8]) {
        screen.dispatchEvent(
          new MouseEvent('mousemove', {
            bubbles: true,
            clientX: rect.x + rect.width * fraction,
            clientY: rect.y + rect.height * 0.5,
            buttons: 0
          })
        )
      }
      screen.dispatchEvent(
        new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          deltaY: -120,
          clientX: rect.x + rect.width * 0.5,
          clientY: rect.y + rect.height * 0.5
        })
      )
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      return { reports, before, after: terminal.buffer.active.viewportY }
    } finally {
      listener.dispose()
    }
  }, tabId)
}

// oxlint-disable-next-line no-empty-pattern -- Manually owned host/client fixtures; testInfo is the second argument.
test('retained remote pane reconciles replacement shell and preserves a surviving agent', async ({}, testInfo) => {
  test.skip(process.platform === 'win32', 'This diagnostic reproduces the POSIX shell replacement')
  expect(process.env.ORCA_BACKGROUND_LAUNCH).toBe('1')
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'orca-replacement-state-'))
  const fixturePath = path.join(scratch, 'agent.mjs')
  const sinkPath = path.join(scratch, 'agent.log')
  writeFileSync(
    fixturePath,
    [
      "import { appendFileSync } from 'node:fs'",
      'const sink = process.argv[2]',
      'appendFileSync(sink, `READY:${process.pid}\\n`)',
      'process.stdin.setRawMode?.(true)',
      "process.stdout.write('\\x1b]0;π - replacement-test\\x07')",
      'process.stdout.write(\'\\x1b]9999;{"state":"idle","agentType":"pi"}\\x07\')',
      'for (let i = 0; i < 80; i++) process.stdout.write(`OLD_AGENT_ROW_${i}\\r\\n`)',
      "process.stdout.write('AGENT_READY\\r\\n\\x1b[?1003h\\x1b[?1006h')",
      'process.stdin.on(\'data\', data => { appendFileSync(sink, `INPUT:${JSON.stringify(data.toString())}\\n`); if (data.toString().includes(\'WARM_PROBE\')) process.stdout.write(\'WARM_PROBE_ACK\\r\\n\'); if (data.toString().includes(\'ARM_STATUS\')) process.stdout.write(\'\\x1b]9999;{"state":"working","prompt":"fixture","agentType":"pi"}\\x07\') })',
      'process.stdin.resume()'
    ].join('\n')
  )
  const host = await launchHeadlessPairedRuntimeHost({ pinnedServePort: true })
  let client: Awaited<ReturnType<typeof launchPairedElectronClient>> | undefined
  const evidence: Record<string, unknown> = {}
  const hostCall: RuntimeRpcCall = async (method, params) =>
    (await host.client.call(method, params)).result as never
  try {
    evidence.hostBuild = await verifyReleaseBuild(host.app)
    const added = await hostCall<{ repo: { id: string } }>('repo.add', {
      path: scratch,
      kind: 'folder'
    })
    const listed = await hostCall<{ worktrees: { id: string }[] }>('worktree.list', {
      repo: `id:${added.repo.id}`
    })
    const worktreeId = listed.worktrees[0]?.id
    if (!worktreeId) {
      throw new Error('Host did not create the disposable folder workspace')
    }
    const created = await createHostCliTerminal(hostCall, worktreeId, fixturePath, sinkPath)
    const before = await hostCall<{ terminal: TerminalSummary }>('terminal.show', {
      terminal: created.handle
    })
    evidence.hostBefore = before.terminal
    const webTabId = toWebTerminalSurfaceTabId(created.tabId)
    client = await launchPairedElectronClient(host.offer, testInfo, 'replacement-test')
    evidence.clientBuild = await verifyReleaseBuild(client.app)
    const { page } = client
    await expect
      .poll(
        () =>
          page.evaluate(
            (id) =>
              window.__store
                ?.getState()
                .allWorktrees()
                .some((w) => w.id === id),
            worktreeId
          ),
        { timeout: 60_000 }
      )
      .toBe(true)
    await page.evaluate(
      ({ worktreeId, environmentId }) => {
        window.__store?.getState().setActiveView('terminal')
        window.__store?.getState().setActiveWorktree(worktreeId, `runtime:${environmentId}`)
      },
      { worktreeId, environmentId: client.environmentId }
    )
    await page
      .locator(`[data-testid="sortable-tab"][data-tab-id="${webTabId}"]`)
      .click({ timeout: 60_000 })
    await expect
      .poll(async () => (await inspectPane(page, webTabId))?.text, { timeout: 30_000 })
      .toContain('AGENT_READY')
    await page.evaluate((id) => {
      const manager = window.__paneManagers?.get(id)
      const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0]
      Reflect.set(window, '__replacementOriginalTerminal', pane?.terminal)
    }, webTabId)
    await expect.poll(async () => (await inspectPane(page, webTabId))?.mouseMode).toBe('any')
    await hostCall('terminal.send', { terminal: created.handle, text: 'ARM_STATUS' })
    await expect
      .poll(
        async () =>
          (await inspectPane(page, webTabId))?.agentStates.some(
            (entry) => entry.agentType === 'pi' && entry.state === 'working'
          ),
        { timeout: 15_000 }
      )
      .toBe(true)
    await installRemoteTerminalGeometryProbe(page, webTabId)
    evidence.before = await inspectPane(page, webTabId)
    expect((evidence.before as Awaited<ReturnType<typeof inspectPane>>)?.title).toMatch(
      /^(?:π|Pi) - replacement-test$/
    )
    evidence.mouseBefore = await probeMouse(page, webTabId)
    expect(
      (evidence.mouseBefore as Awaited<ReturnType<typeof probeMouse>>).reports.length
    ).toBeGreaterThan(0)
    await captureHiddenRenderer(page, testInfo, 'before-restart')

    // A process-only serve restart must not be confused with replacing its daemon-backed PTY.
    await host.restartServeProcess()
    evidence.warmHostBuild = await verifyReleaseBuild(host.app)
    await expect
      .poll(async () => (await inspectPane(page, webTabId))?.text, { timeout: 45_000 })
      .toContain('AGENT_READY')
    let warm: TerminalSummary | undefined
    await expect
      .poll(
        async () => {
          const inventory = await hostCall<{ terminals: TerminalSummary[] }>('terminal.list', {
            worktree: `id:${worktreeId}`
          })
          warm = inventory.terminals.find((t) => t.ptyId === before.terminal.ptyId)
          return warm?.incarnationId
        },
        { timeout: 45_000 }
      )
      .toBe(before.terminal.incarnationId)
    if (!warm) {
      throw new Error('Host did not re-publish the surviving terminal')
    }
    await hostCall('terminal.send', { terminal: warm.handle, text: 'WARM_PROBE' })
    await expect
      .poll(async () => (await inspectPane(page, webTabId))?.text, {
        timeout: 45_000
      })
      .toContain('WARM_PROBE_ACK')
    evidence.warmImmediate = await inspectPane(page, webTabId)
    await expect
      .configure({ soft: true })
      .poll(
        async () => {
          const pane = await inspectPane(page, webTabId)
          return Boolean(
            pane && pane.cols === pane.proposedGrid?.cols && pane.rows === pane.proposedGrid?.rows
          )
        },
        { timeout: 10_000, message: 'Reconnect geometry did not recover within 10 seconds' }
      )
      .toBe(true)
    evidence.warm = await inspectPane(page, webTabId)
    await captureHiddenRenderer(page, testInfo, 'after-warm-restart')
    expect.soft((evidence.warm as Awaited<ReturnType<typeof inspectPane>>)?.sameTerminal).toBe(true)
    expect.soft((evidence.warm as Awaited<ReturnType<typeof inspectPane>>)?.mouseMode).toBe('any')
    evidence.mouseWarm = await probeMouse(page, webTabId)
    expect
      .soft((evidence.mouseWarm as Awaited<ReturnType<typeof probeMouse>>).reports.length)
      .toBeGreaterThan(0)

    // Only the daemon owned by this freshly-created temporary profile is retired.
    await host.restartServeProcess({ betweenProcesses: () => cleanupE2EDaemons(host.userDataDir) })
    evidence.replacementHostBuild = await verifyReleaseBuild(host.app)
    let replacement: TerminalSummary | undefined
    await expect
      .poll(
        async () => {
          const inventory = await hostCall<{ terminals: TerminalSummary[] }>('terminal.list', {
            worktree: `id:${worktreeId}`
          })
          replacement = inventory.terminals.find((t) => t.ptyId === before.terminal.ptyId)
          return Boolean(
            replacement?.incarnationId &&
            replacement.incarnationId !== before.terminal.incarnationId
          )
        },
        { timeout: 60_000 }
      )
      .toBe(true)
    if (!replacement) {
      throw new Error('Host never published the replacement terminal')
    }
    evidence.hostAfter = replacement
    evidence.hostSessionAfter = await hostCall('session.tabs.list', {
      worktree: `id:${worktreeId}`
    })
    // The host owns the published identity; the client mirror can only hide what the host sent,
    // so the predecessor's label/agent must be absent where it is produced.
    expect.soft(replacement.title ?? '').not.toMatch(/^(?:π|Pi) - replacement-test$/)
    expect.soft(replacement.agentIdentity).toBeUndefined()
    const hostSessionTabs = (evidence.hostSessionAfter as { tabs?: HostSessionTab[] }).tabs ?? []
    expect
      .soft(hostSessionTabs.some((tab) => /^(?:π|Pi) - replacement-test$/.test(tab.title ?? '')))
      .toBe(false)
    expect.soft(hostSessionTabs.some((tab) => tab.agentStatus?.agentType === 'pi')).toBe(false)
    evidence.hostScreen = await hostCall('terminal.read', {
      terminal: replacement.handle,
      screen: true
    })
    await expect
      .poll(
        async () => {
          const pane = await inspectPane(page, webTabId)
          return { ptyId: pane?.ptyId, phase: pane?.recoveryPhase }
        },
        { timeout: 45_000 }
      )
      .toEqual({
        ptyId: toRemoteRuntimePtyId(replacement.handle, client.environmentId),
        phase: 'connected'
      })
    await expect
      .configure({ soft: true })
      .poll(
        async () => {
          const pane = await inspectPane(page, webTabId)
          return Boolean(
            pane &&
            pane.mouseMode === 'none' &&
            !/^(?:π|Pi) - replacement-test$/.test(pane.title ?? '') &&
            pane.cols === pane.proposedGrid?.cols &&
            pane.rows === pane.proposedGrid?.rows &&
            !pane.agentStates.some((entry) => entry.agentType === 'pi')
          )
        },
        { timeout: 10_000, message: 'Replacement retained agent modes/status after settling' }
      )
      .toBe(true)
    evidence.after = await inspectPane(page, webTabId)
    evidence.mouseAfter = await probeMouse(page, webTabId)
    evidence.hostScreenAfterMouse = await hostCall('terminal.read', {
      terminal: replacement.handle,
      screen: true
    })
    await captureHiddenRenderer(page, testInfo, 'after-replacement')
    const after = evidence.after as Awaited<ReturnType<typeof inspectPane>>
    expect.soft(after?.sameTerminal).toBe(true)
    expect.soft(after?.mouseMode).toBe('none')
    expect.soft(after?.invisibleCharacters).toBe(0)
    expect
      .soft((evidence.mouseAfter as Awaited<ReturnType<typeof probeMouse>>).reports)
      .toHaveLength(0)
    expect.soft(after?.title).not.toMatch(/^(?:π|Pi) - replacement-test$/)
    expect.soft(after?.agentStates.some((entry) => entry.agentType === 'pi')).toBe(false)
    expect.soft(after?.cols).toBe(after?.proposedGrid?.cols)
    expect.soft(after?.rows).toBe(after?.proposedGrid?.rows)
    const hostScreen = evidence.hostScreen as { terminal: { tail: string[]; source?: string } }
    expect(hostScreen.terminal.source).toBe('screen')
    const prompt = hostScreen.terminal.tail.at(-1)?.trim()
    expect(prompt).toBeTruthy()
    expect.soft(after?.text).toContain(prompt)
    const afterMouse = evidence.hostScreenAfterMouse as { terminal: { tail: string[] } }
    expect.soft(afterMouse.terminal.tail.join('\n')).not.toMatch(/(?:35|64);\d+;\d+[Mm]/)
    expect
      .soft(
        readSink(sinkPath)
          .split('\n')
          .filter((line) => line.startsWith('READY:'))
      )
      .toHaveLength(1)
  } finally {
    if (client) {
      evidence.geometryEvents = await readRemoteTerminalGeometryProbe(client.page).catch(() => null)
    }
    evidence.fixtureLog = readSink(sinkPath)
    writeFileSync(
      testInfo.outputPath('replacement-evidence.json'),
      JSON.stringify(evidence, null, 2)
    )
    try {
      await client?.dispose()
    } finally {
      await host.dispose()
      rmSync(scratch, { recursive: true, force: true })
    }
  }
})
