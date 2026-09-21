/**
 * A paired viewer must not erase a verified mirrored PTY binding while a
 * restarted `orca serve` process republishes the same surface as pending, and
 * the surviving daemon PTY must keep appending to its durable history log.
 *
 * Run:
 *   pnpm exec playwright test \
 *     tests/e2e/paired-remote-terminal-serve-restart-binding.spec.ts \
 *     --config tests/playwright.config.ts --project electron-headless --workers=1
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { getHistorySessionDirName } from '../../src/main/daemon/history-paths'
import { LOG_HEADER_BYTES } from '../../src/main/daemon/terminal-history-log'
import { DEFAULT_LOCAL_ORCA_PROFILE_ID } from '../../src/shared/orca-profiles'
import type { RuntimeMobileSessionTabsResult } from '../../src/shared/runtime-types'
import { toRemoteRuntimePtyId } from '../../src/shared/remote-runtime-pty-id'
import { toWebTerminalSurfaceTabId } from '../../src/shared/terminal-surface-id'
import { expect, test } from './helpers/orca-app'
import {
  launchHeadlessPairedRuntimeHost,
  type HeadlessPairedRuntimeHost
} from './helpers/headless-paired-runtime-host'
import {
  createHostCliTerminal,
  createRetentionFixtureDirectory,
  readSink
} from './helpers/host-created-terminal-retention-oracle'
import {
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import {
  clearPairedTerminalSnapshotProbeErrors,
  disposePairedTerminalRestartProbes,
  installPairedTerminalBindingProbe,
  installPairedTerminalSnapshotProbe,
  readPairedTerminalBindingTransitions,
  readPairedTerminalSnapshotProbe,
  setPairedTerminalProbePhase,
  type PairedTerminalSnapshotReceipt
} from './helpers/paired-terminal-restart-renderer-probes'

const scratch = createRetentionFixtureDirectory()
const fixturePath = path.join(scratch, 'serve-restart-binding-terminal.mjs')
const sinkPath = path.join(scratch, 'serve-restart-binding-terminal.log')

writeFileSync(
  fixturePath,
  [
    "import { execFileSync } from 'node:child_process'",
    "import { appendFileSync } from 'node:fs'",
    'const sink = process.argv[2]',
    'const grid = () => {',
    "  if (process.platform !== 'win32') return `${process.stdout.columns ?? 0}x${process.stdout.rows ?? 0}`",
    '  try {',
    "    const mode = execFileSync('mode.com', ['con'], { encoding: 'utf8', timeout: 1000 })",
    '    const columns = mode.match(/Columns:\\s*(\\d+)/i)?.[1]',
    '    const rows = mode.match(/Lines:\\s*(\\d+)/i)?.[1]',
    '    if (columns && rows) return `${columns}x${rows}`',
    '  } catch {}',
    '  return `${process.stdout.columns ?? 0}x${process.stdout.rows ?? 0}`',
    '}',
    'const record = (line) => appendFileSync(sink, `${line}\\n`)',
    'const startGrid = grid()',
    'record(`READY:${process.pid}:${startGrid}`)',
    'process.stdout.write(`READY:${process.pid}:${startGrid}\\r\\n`)',
    "process.stdin.setEncoding('utf8')",
    "let pending = ''",
    "process.stdin.on('data', (data) => {",
    '  pending += data',
    '  const lines = pending.split(/\\r\\n|\\r|\\n/)',
    "  pending = lines.pop() ?? ''",
    '  for (const line of lines) {',
    '    const measuredGrid = grid()',
    '    const entry = `LINE:${line}:${measuredGrid}`',
    '    record(entry)',
    '    process.stdout.write(`LIVE:${line}:${measuredGrid}\\r\\n`)',
    '  }',
    '})',
    'process.stdin.resume()'
  ].join('\n')
)

test.afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

type HostSurface = {
  leafId: string
  parentTabId: string
  ptyId: string | null
  status: 'pending-handle' | 'ready'
  terminal: string | null
}

type MirroredTerminal = {
  handle: string
  leafId: string
  parentTabId: string
  ptyId: string
  webTabId: string
}

type Grid = { cols: number; rows: number }

type HistoryLogEvidence = {
  containsMarker: boolean
  size: number
}

type PersistedData = {
  workspaceSession?: {
    terminalLayoutsByTabId?: Record<string, { ptyIdsByLeafId?: Record<string, string | null> }>
  }
}

function persistedDataPath(userDataDir: string): string {
  return path.join(userDataDir, 'profiles', DEFAULT_LOCAL_ORCA_PROFILE_ID, 'orca-data.json')
}

function removePersistedTerminalBinding(
  userDataDir: string,
  terminal: Pick<MirroredTerminal, 'leafId' | 'parentTabId' | 'ptyId'>
): void {
  const dataPath = persistedDataPath(userDataDir)
  const data = JSON.parse(readFileSync(dataPath, 'utf8')) as PersistedData
  const bindings =
    data.workspaceSession?.terminalLayoutsByTabId?.[terminal.parentTabId]?.ptyIdsByLeafId
  if (bindings?.[terminal.leafId] !== terminal.ptyId) {
    throw new Error('Expected the live terminal binding before removing it from persisted state')
  }
  delete bindings[terminal.leafId]
  writeFileSync(dataPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

function readHistoryLogEvidence(outputLogPath: string, marker: string): HistoryLogEvidence {
  try {
    const contents = readFileSync(outputLogPath)
    return { containsMarker: contents.includes(marker), size: contents.byteLength }
  } catch {
    return { containsMarker: false, size: 0 }
  }
}

function historyCheckpointContains(checkpointPath: string, marker: string): boolean {
  try {
    return readFileSync(checkpointPath, 'utf8').includes(marker)
  } catch {
    return false
  }
}

async function waitForHistoryLogMarker(
  outputLogPath: string,
  marker: string,
  minimumSize = 0
): Promise<number> {
  let evidence: HistoryLogEvidence = { containsMarker: false, size: 0 }
  await expect
    .poll(
      () => {
        evidence = readHistoryLogEvidence(outputLogPath, marker)
        return evidence.containsMarker && evidence.size > minimumSize
      },
      { timeout: 30_000, message: `Terminal history did not persist ${marker}` }
    )
    .toBe(true)
  return evidence.size
}

async function callRuntime<TResult>(
  client: PairedElectronClient,
  method: string,
  params: unknown
): Promise<TResult> {
  return client.page.evaluate(
    async ({ environmentId, method, params }) => {
      const response = await window.api.runtimeEnvironments.call({
        selector: environmentId,
        method,
        params,
        timeoutMs: 30_000
      })
      if (!response.ok) {
        throw new Error(`${response.error.code}: ${response.error.message}`)
      }
      return response.result
    },
    { environmentId: client.environmentId, method, params }
  ) as Promise<TResult>
}

async function showClient(app: ElectronApplication, page: Page): Promise<void> {
  const window = await app.browserWindow(page)
  await window.evaluate((browserWindow) => {
    browserWindow.setSize(1100, 720)
    browserWindow.show()
    browserWindow.focus()
  })
  await expect.poll(() => window.evaluate((browserWindow) => browserWindow.isVisible())).toBe(true)
}

async function waitForWorktree(host: HeadlessPairedRuntimeHost, repoId: string): Promise<string> {
  let worktreeId = ''
  await expect
    .poll(
      async () => {
        const listed = await host.client.call<{ worktrees: { id: string }[] }>('worktree.list', {
          repo: `id:${repoId}`
        })
        worktreeId = listed.result.worktrees[0]?.id ?? ''
        return worktreeId
      },
      { timeout: 30_000, message: 'Serve host never listed its folder workspace' }
    )
    .not.toBe('')
  return worktreeId
}

async function waitForClientWorktree(page: Page, worktreeId: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          (id) =>
            window.__store
              ?.getState()
              .allWorktrees()
              .some((worktree) => worktree.id === id) ?? false,
          worktreeId
        ),
      { timeout: 60_000, message: 'Paired client never received the serve-host workspace' }
    )
    .toBe(true)
}

async function createMirroredTerminal(
  client: PairedElectronClient,
  worktreeId: string
): Promise<MirroredTerminal> {
  writeFileSync(sinkPath, '')
  const created = await createHostCliTerminal(
    (method, params) => callRuntime(client, method, params),
    worktreeId,
    fixturePath,
    sinkPath
  )
  return {
    handle: created.handle,
    leafId: created.leafId,
    parentTabId: created.tabId,
    ptyId: created.ptyId,
    webTabId: toWebTerminalSurfaceTabId(created.tabId)
  }
}

async function openMirroredTerminal(
  client: PairedElectronClient,
  worktreeId: string,
  webTabId: string
): Promise<void> {
  await client.page.evaluate(
    ({ environmentId, worktreeId }) => {
      const state = window.__store?.getState()
      state?.setActiveView('terminal')
      state?.setActiveWorktree(worktreeId, `runtime:${environmentId}`)
    },
    { environmentId: client.environmentId, worktreeId }
  )
  const tab = client.page.locator(`[data-testid="sortable-tab"][data-tab-id="${webTabId}"]`)
  await expect(tab).toBeVisible({ timeout: 60_000 })
  await tab.click()
  await expect(tab).toHaveAttribute('data-active', 'true')
  await expect
    .poll(() => client.page.evaluate((id) => window.__paneManagers?.has(id) ?? false, webTabId), {
      timeout: 60_000,
      message: 'Mirrored terminal pane never mounted'
    })
    .toBe(true)
}

async function readPaneContent(page: Page, webTabId: string): Promise<string> {
  return page.evaluate((id) => {
    const manager = window.__paneManagers?.get(id)
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    return pane?.serializeAddon?.serialize?.() ?? ''
  }, webTabId)
}

async function readPaneGrid(page: Page, webTabId: string): Promise<Grid | null> {
  return page.evaluate((id) => {
    const manager = window.__paneManagers?.get(id)
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    return pane ? { cols: pane.terminal.cols, rows: pane.terminal.rows } : null
  }, webTabId)
}

async function waitForStablePaneGrid(
  page: Page,
  webTabId: string,
  differentFrom?: Grid
): Promise<Grid> {
  let candidate: Grid | null = null
  let candidateKey = ''
  let stableSamples = 0
  await expect
    .poll(
      async () => {
        const grid = await readPaneGrid(page, webTabId)
        if (
          !grid ||
          (differentFrom && grid.cols === differentFrom.cols && grid.rows === differentFrom.rows)
        ) {
          stableSamples = 0
          return null
        }
        const key = `${grid.cols}x${grid.rows}`
        stableSamples = key === candidateKey ? stableSamples + 1 : 1
        candidateKey = key
        candidate = grid
        return stableSamples >= 3 ? candidate : null
      },
      { intervals: [100, 100, 200], timeout: 30_000, message: 'Rendered pane grid did not settle' }
    )
    .not.toBeNull()
  return candidate!
}

async function focusAndType(page: Page, webTabId: string, text: string): Promise<void> {
  await page.evaluate((id) => {
    const manager = window.__paneManagers?.get(id)
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    const textarea = pane?.container.querySelector('.xterm-helper-textarea') as
      | HTMLTextAreaElement
      | undefined
    if (!pane || !textarea) {
      throw new Error(`Mirrored pane ${id} has no terminal input`)
    }
    pane.terminal.focus()
    textarea.focus()
  }, webTabId)
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
}

function lastFixtureGrid(prefix: string): Grid | null {
  const line = readSink(sinkPath)
    .split(/\r?\n/)
    .findLast((entry) => entry.startsWith(`LINE:${prefix}`))
  const match = line?.match(/:(\d+)x(\d+)$/)
  return match ? { cols: Number(match[1]), rows: Number(match[2]) } : null
}

async function waitForHostGrid(
  client: PairedElectronClient,
  terminal: string,
  expected: Grid,
  prefix: string
): Promise<void> {
  let attempt = 0
  await expect
    .poll(
      async () => {
        await callRuntime(client, 'terminal.send', {
          terminal,
          text: `${prefix}-${attempt++}`,
          enter: true
        })
        return lastFixtureGrid(prefix)
      },
      { timeout: 30_000, message: 'Serve-host PTY grid never matched the rendered pane' }
    )
    .toEqual(expected)
}

async function expectKeyboardRoundTrip(
  client: PairedElectronClient,
  terminal: MirroredTerminal,
  marker: string,
  grid: Grid
): Promise<void> {
  await focusAndType(client.page, terminal.webTabId, marker)
  const expectedSink = `LINE:${marker}:${grid.cols}x${grid.rows}`
  const expectedPaint = `LIVE:${marker}:${grid.cols}x${grid.rows}`
  await expect.poll(() => readSink(sinkPath), { timeout: 15_000 }).toContain(expectedSink)
  await expect
    .poll(() => readPaneContent(client.page, terminal.webTabId), { timeout: 15_000 })
    .toContain(expectedPaint)
}

async function readHostSurface(
  host: HeadlessPairedRuntimeHost,
  worktreeId: string,
  expected: Pick<MirroredTerminal, 'leafId' | 'parentTabId' | 'ptyId'>
): Promise<HostSurface | null> {
  const response = await host.client.call<RuntimeMobileSessionTabsResult>('session.tabs.list', {
    worktree: `id:${worktreeId}`
  })
  const matches = response.result.tabs.filter(
    (tab) =>
      tab.type === 'terminal' &&
      tab.parentTabId === expected.parentTabId &&
      tab.leafId === expected.leafId &&
      tab.ptyId === expected.ptyId
  )
  if (matches.length > 1) {
    throw new Error(
      `Host published ${matches.length} duplicate surfaces for ${expected.parentTabId}:${expected.leafId}`
    )
  }
  const surface = matches[0]
  if (!surface || surface.type !== 'terminal') {
    return null
  }
  return {
    leafId: surface.leafId,
    parentTabId: surface.parentTabId,
    ptyId: surface.ptyId ?? null,
    status: surface.status,
    terminal: surface.terminal
  }
}

async function waitForClientBinding(
  client: PairedElectronClient,
  worktreeId: string,
  terminal: MirroredTerminal,
  expectedPtyId: string
): Promise<void> {
  try {
    await expect
      .poll(
        () =>
          client.page.evaluate(
            ({ leafId, webTabId, worktreeId }) => {
              const state = window.__store?.getState()
              const tab = (state?.tabsByWorktree[worktreeId] ?? []).find(
                (candidate) => candidate.id === webTabId
              )
              const manager = window.__paneManagers?.get(webTabId)
              const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
              return {
                binding: state?.terminalLayoutsByTabId[webTabId]?.ptyIdsByLeafId?.[leafId] ?? null,
                panePtyId: pane?.container.dataset.ptyId ?? null,
                tabPtyId: tab?.ptyId ?? null
              }
            },
            { leafId: terminal.leafId, webTabId: terminal.webTabId, worktreeId }
          ),
        { timeout: 120_000, message: 'Mirrored pane never converged on the republished handle' }
      )
      .toEqual({ binding: expectedPtyId, panePtyId: expectedPtyId, tabPtyId: expectedPtyId })
  } catch (error) {
    const [transitions, snapshots] = await Promise.all([
      readPairedTerminalBindingTransitions(client.page),
      readPairedTerminalSnapshotProbe(client.page)
    ])
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n` +
        `Binding transitions: ${JSON.stringify(transitions, null, 2)}\n` +
        `Snapshot receipts: ${JSON.stringify(snapshots, null, 2)}`
    )
  }
}

test('retains a verified mirrored PTY binding through a serve restart pending snapshot', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(420_000)
  const host = await launchHeadlessPairedRuntimeHost({ pinnedServePort: true })
  let client: PairedElectronClient | null = null
  let terminal: MirroredTerminal | null = null
  let liveHandle: string | null = null
  const pageErrors: string[] = []
  try {
    const added = await host.client.call<{ repo: { id: string } }>('repo.add', {
      path: testRepoPath,
      kind: 'folder'
    })
    const worktreeId = await waitForWorktree(host, added.result.repo.id)
    client = await launchPairedElectronClient(host.offer, testInfo, 'serve-restart-binding')
    client.page.on('pageerror', (error) => pageErrors.push(String(error)))
    await showClient(client.app, client.page)
    await waitForClientWorktree(client.page, worktreeId)

    terminal = await createMirroredTerminal(client, worktreeId)
    liveHandle = terminal.handle
    await openMirroredTerminal(client, worktreeId, terminal.webTabId)
    await expect
      .poll(() => readPaneContent(client!.page, terminal!.webTabId), { timeout: 30_000 })
      .toContain('READY:')

    const initialRemotePtyId = toRemoteRuntimePtyId(terminal.handle, client.environmentId)
    await waitForClientBinding(client, worktreeId, terminal, initialRemotePtyId)
    const initialGrid = await waitForStablePaneGrid(client.page, terminal.webTabId)
    await waitForHostGrid(client, terminal.handle, initialGrid, 'FIT_BEFORE')
    await expectKeyboardRoundTrip(client, terminal, 'KEYBOARD_BEFORE_RESTART', initialGrid)
    const historyOutputLogPath = path.join(
      host.userDataDir,
      'terminal-history',
      getHistorySessionDirName(terminal.ptyId),
      'output.log'
    )
    const historyCheckpointPath = path.join(
      host.userDataDir,
      'terminal-history',
      getHistorySessionDirName(terminal.ptyId),
      'checkpoint.json'
    )
    await waitForHistoryLogMarker(historyOutputLogPath, 'LIVE:KEYBOARD_BEFORE_RESTART')

    const initialReadyLines = readSink(sinkPath)
      .split(/\r?\n/)
      .filter((line) => line.startsWith('READY:'))
    expect(initialReadyLines).toHaveLength(1)
    const initialHostSurface = await readHostSurface(host, worktreeId, terminal)
    expect(initialHostSurface).toMatchObject({
      leafId: terminal.leafId,
      ptyId: terminal.ptyId,
      status: 'ready',
      terminal: terminal.handle
    })

    await installPairedTerminalBindingProbe(client.page, { ...terminal, worktreeId })
    await installPairedTerminalSnapshotProbe(client.page, client.environmentId, terminal)
    await setPairedTerminalProbePhase(client.page, 'restart')
    const hostPidBeforeRestart = host.app.process().pid
    if (!hostPidBeforeRestart) {
      throw new Error('Serve process has no PID')
    }
    // Why: recreate the reported lost host binding while keeping the real tab, layout, and daemon PTY alive.
    await host.restartServeProcess({
      betweenProcesses: () => removePersistedTerminalBinding(host.userDataDir, terminal!)
    })
    expect(host.app.process().pid, 'The serve Electron process must actually be replaced').not.toBe(
      hostPidBeforeRestart
    )
    let pendingReceipt: PairedTerminalSnapshotReceipt | null = null
    await expect
      .poll(
        async () => {
          pendingReceipt =
            (await readPairedTerminalSnapshotProbe(client!.page)).receipts.find(
              (receipt) => receipt.status === 'pending-handle'
            ) ?? null
          return pendingReceipt
        },
        {
          timeout: 60_000,
          message: 'Paired renderer never received the replacement host pending-handle frame'
        }
      )
      .not.toBeNull()
    expect(pendingReceipt).toMatchObject({
      leafId: terminal.leafId,
      parentTabId: terminal.parentTabId,
      ptyId: terminal.ptyId,
      status: 'pending-handle',
      terminal: null
    })

    let recoveredSurface: HostSurface | null = null
    await expect
      .poll(
        async () => {
          recoveredSurface = await readHostSurface(host, worktreeId, terminal!)
          return recoveredSurface?.status === 'ready' ? recoveredSurface.terminal : null
        },
        { timeout: 120_000, message: 'Replacement host never republished a ready handle' }
      )
      .not.toBeNull()
    liveHandle = recoveredSurface!.terminal
    expect(liveHandle).not.toBeNull()
    expect(recoveredSurface).toMatchObject({
      leafId: terminal.leafId,
      parentTabId: terminal.parentTabId,
      ptyId: terminal.ptyId,
      status: 'ready'
    })

    const recoveredRemotePtyId = toRemoteRuntimePtyId(liveHandle!, client.environmentId)
    await waitForClientBinding(client, worktreeId, terminal, recoveredRemotePtyId)
    await expect
      .poll(
        () => historyCheckpointContains(historyCheckpointPath, 'LIVE:KEYBOARD_BEFORE_RESTART'),
        { timeout: 30_000, message: 'Warm reattach did not preserve the pre-restart history' }
      )
      .toBe(true)
    const restartTransitions = (await readPairedTerminalBindingTransitions(client.page)).filter(
      (transition) => transition.phase === 'restart'
    )
    expect(restartTransitions.length, 'Binding observer recorded no restart state').toBeGreaterThan(
      0
    )
    const invalidRestartTransitions = restartTransitions.filter(
      (transition) =>
        !transition.tabPresent ||
        !transition.layoutPresent ||
        transition.binding === null ||
        transition.bindings.length === 0 ||
        transition.tabPtyId !== transition.binding
    )

    await callRuntime(client, 'terminal.send', {
      terminal: liveHandle,
      text: 'OUTPUT_AFTER_RESTART',
      enter: true
    })
    await expect
      .poll(() => readPaneContent(client!.page, terminal!.webTabId), { timeout: 15_000 })
      .toContain('LIVE:OUTPUT_AFTER_RESTART:')
    await expect(client.page.locator('[data-terminal-error-toast]')).toHaveCount(0)
    const restartProbeErrors = (await readPairedTerminalSnapshotProbe(client.page)).errors
    expect(
      restartProbeErrors.filter((error) => !error.startsWith('remote_runtime_unavailable:')),
      'Raw session-tab subscription reported an unexpected restart error'
    ).toEqual([])
    await clearPairedTerminalSnapshotProbeErrors(client.page)

    await client.app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      if (!window) {
        throw new Error('Paired client has no Electron window')
      }
      window.setSize(1400, 900)
    })
    const resizedGrid = await waitForStablePaneGrid(client.page, terminal.webTabId, initialGrid)
    await waitForHostGrid(client, liveHandle!, resizedGrid, 'FIT_AFTER')
    await expectKeyboardRoundTrip(client, terminal, 'KEYBOARD_AFTER_RESTART', resizedGrid)
    const historySizeAfterRestart = await waitForHistoryLogMarker(
      historyOutputLogPath,
      'LIVE:KEYBOARD_AFTER_RESTART',
      LOG_HEADER_BYTES
    )
    expect(historySizeAfterRestart).toBeGreaterThan(LOG_HEADER_BYTES)
    expect(
      readSink(sinkPath)
        .split(/\r?\n/)
        .filter((line) => line.startsWith('READY:')),
      'Restart recovery must retain the original fixture process, not respawn it'
    ).toEqual(initialReadyLines)
    expect(
      invalidRestartTransitions,
      'A pending-handle publication erased or removed the verified mirrored binding'
    ).toEqual([])
    expect((await readPairedTerminalSnapshotProbe(client.page)).errors).toEqual([])

    await setPairedTerminalProbePhase(client.page, 'close')
    await callRuntime(client, 'terminal.closeTab', { terminal: liveHandle })
    liveHandle = null
    await expect
      .poll(
        () =>
          client!.page.evaluate(
            ({ webTabId, worktreeId }) => {
              const state = window.__store?.getState()
              return {
                bindingList: state?.ptyIdsByTabId[webTabId] ?? null,
                layout: state?.terminalLayoutsByTabId[webTabId] ?? null,
                tabPresent: (state?.tabsByWorktree[worktreeId] ?? []).some(
                  (tab) => tab.id === webTabId
                )
              }
            },
            { webTabId: terminal!.webTabId, worktreeId }
          ),
        { timeout: 60_000, message: 'Authoritative host close did not retire the mirrored tab' }
      )
      .toEqual({ bindingList: null, layout: null, tabPresent: false })
    await expect
      .poll(() => readHostSurface(host, worktreeId, terminal!), { timeout: 30_000 })
      .toBeNull()
    expect(await client.getDirectSshAttemptTargetIds()).toEqual([])
    expect(pageErrors, 'Paired renderer raised an uncaught error').toEqual([])
  } finally {
    if (client) {
      await disposePairedTerminalRestartProbes(client.page)
      if (liveHandle) {
        await callRuntime(client, 'terminal.closeTab', { terminal: liveHandle }).catch(
          () => undefined
        )
      }
      await client.dispose()
    }
    await host.dispose()
  }
})
