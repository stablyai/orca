import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { retryTransientMainEvaluate } from './helpers/electron-main-evaluate-retry'
import {
  ensureTerminalVisible,
  getAllWorktreeIds,
  switchToWorktree,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import {
  getTerminalContent,
  resolveActiveTabId,
  splitActiveTerminalPane,
  waitForActiveTerminalManager,
  waitForPaneCount
} from './helpers/terminal'

// GPU recovery now requires a recent failure and an exactly zero working set on Windows.
// These tests cover ordinary GPU recovery and the boundary without that evidence.

const RENDERER_PROBE_TIMEOUT_MS = 5_000
// Covers the watchdog's ping interval + stall timeout, with slack for a cold GPU relaunch.
const RENDERER_RECOVERY_TIMEOUT_MS = 30_000
const PANE_COUNT = 4
// Why node: one command line that zsh, PowerShell and cmd all run unchanged.
const STREAM_COMMAND =
  'node -e "setInterval(function(){for(var i=0;i<200;i++)console.log(Date.now()+\' stream \'+i)},5)"'

type WorktreePair = { firstWorktreeId: string; otherWorktreeId: string }
type RendererProbe = { responsive: true; heartbeatAgeMs: number } | { responsive: false }

async function gpuPids(app: ElectronApplication): Promise<number[]> {
  return retryTransientMainEvaluate(() =>
    app.evaluate(({ app: electronApp }) =>
      electronApp
        .getAppMetrics()
        .filter((metric) => metric.type === 'GPU')
        .map((metric) => metric.pid)
    )
  )
}

function setProcessSuspended(pid: number, suspended: boolean): void {
  if (process.platform === 'win32') {
    throw new Error('Windows suspension needs an isolated native adapter')
  }
  process.kill(pid, suspended ? 'SIGSTOP' : 'SIGCONT')
}

function resumeIfAlive(pid: number): void {
  try {
    setProcessSuspended(pid, false)
  } catch {
    // The GPU process may already have exited.
  }
}

async function probeRenderer(page: Page): Promise<RendererProbe> {
  const probe = page
    .evaluate(() => {
      const lastBeat = Number(document.documentElement.dataset.gpuWedgeHeartbeat ?? 0)
      return { responsive: true as const, heartbeatAgeMs: Date.now() - lastBeat }
    })
    .catch((): RendererProbe => ({ responsive: false }))
  const timeout = new Promise<RendererProbe>((resolve) =>
    setTimeout(() => resolve({ responsive: false }), RENDERER_PROBE_TIMEOUT_MS)
  )
  return Promise.race([probe, timeout])
}

function isHealthy(probe: RendererProbe): boolean {
  return probe.responsive && probe.heartbeatAgeMs < 1_500
}

async function waitForHealthyRenderer(page: Page): Promise<RendererProbe> {
  const deadline = Date.now() + RENDERER_RECOVERY_TIMEOUT_MS
  let probe = await probeRenderer(page)
  while (!isHealthy(probe) && Date.now() < deadline) {
    probe = await probeRenderer(page)
  }
  return probe
}

async function webglPaneCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    let count = 0
    for (const manager of window.__paneManagers?.values() ?? []) {
      count += (manager.getRenderingDiagnostics?.() ?? []).filter((d) => d.hasWebgl).length
    }
    return count
  })
}

async function setTerminalGpuAcceleration(page: Page, mode: 'on' | 'off'): Promise<void> {
  await page.evaluate((nextMode) => {
    const state = window.__store?.getState()
    if (!state?.settings) {
      throw new Error('Store unavailable')
    }
    window.__store?.setState({ settings: { ...state.settings, terminalGpuAcceleration: nextMode } })
    for (const manager of window.__paneManagers?.values() ?? []) {
      manager.setTerminalGpuAcceleration(nextMode)
    }
  }, mode)
}

async function startStreamingPanes(page: Page): Promise<void> {
  for (let index = 1; index < PANE_COUNT; index += 1) {
    await splitActiveTerminalPane(page, index % 2 === 0 ? 'horizontal' : 'vertical')
    await waitForPaneCount(page, index + 1)
  }
  const tabId = await resolveActiveTabId(page)
  await expect
    .poll(
      () =>
        page.evaluate(
          (id) => (id ? (window.__store?.getState().ptyIdsByTabId[id]?.length ?? 0) : 0),
          tabId
        ),
      { timeout: 20_000 }
    )
    .toBe(PANE_COUNT)
  // Why: a command typed before the shell prompt can be swallowed by startup.
  await new Promise((resolve) => setTimeout(resolve, 3_000))
  await page.evaluate(
    ({ id, command }) => {
      for (const ptyId of (id ? window.__store?.getState().ptyIdsByTabId[id] : null) ?? []) {
        window.api.pty.write(String(ptyId), `${command}\r`, 'driving')
      }
    },
    { id: tabId, command: STREAM_COMMAND }
  )
}

async function setUpStreamingWorkspace(page: Page, mode: 'on' | 'off'): Promise<WorktreePair> {
  await waitForSessionReady(page)
  const firstWorktreeId = await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page)
  await setTerminalGpuAcceleration(page, mode)
  await startStreamingPanes(page)
  await setTerminalGpuAcceleration(page, mode)
  await expect.poll(() => getTerminalContent(page), { timeout: 20_000 }).toContain(' stream ')
  if (mode === 'on') {
    await expect.poll(() => webglPaneCount(page), { timeout: 15_000 }).toBeGreaterThan(0)
  }
  const otherWorktreeId = (await getAllWorktreeIds(page)).find((id) => id !== firstWorktreeId)
  if (!otherWorktreeId) {
    throw new Error('Seeded repo needs a second worktree')
  }
  await page.evaluate(() => {
    document.documentElement.dataset.gpuWedgeHeartbeat = String(Date.now())
    setInterval(() => {
      document.documentElement.dataset.gpuWedgeHeartbeat = String(Date.now())
    }, 100)
  })
  return { firstWorktreeId, otherWorktreeId }
}

// Each switch reveals the other workspace's terminals: reattach + settled-reveal atlas reset.
async function revealWorktree(page: Page, ids: WorktreePair, round: number): Promise<void> {
  await switchToWorktree(page, round % 2 === 0 ? ids.otherWorktreeId : ids.firstWorktreeId)
  if (round % 2 === 1) {
    await ensureTerminalVisible(page)
  }
}

async function expectRendererSurvivesReveals(
  page: Page,
  ids: WorktreePair,
  label: string
): Promise<void> {
  const timeline: string[] = []
  for (let round = 0; round < 3; round += 1) {
    await revealWorktree(page, ids, round)
    await new Promise((resolve) => setTimeout(resolve, 3_000))
    const probe = await waitForHealthyRenderer(page)
    timeline.push(`${label} reveal=${round} probe=${JSON.stringify(probe)}`)
    if (!isHealthy(probe)) {
      break
    }
  }
  expect(
    timeline.length === 3 && timeline.every((entry) => entry.includes('"responsive":true')),
    timeline.join('\n')
  ).toBe(true)
}

async function requireGpuCapability(page: Page, app: ElectronApplication): Promise<void> {
  await waitForSessionReady(page)
  const hasWebgl = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('webgl2') ?? canvas.getContext('webgl')
    context?.getExtension('WEBGL_lose_context')?.loseContext()
    return context !== null
  })
  test.skip(!hasWebgl, 'This runner has no usable WebGL context')
  test.skip((await gpuPids(app)).length !== 1, 'This runner has no single GPU process')
}

test.describe('terminal renderer around GPU process failures', () => {
  test('renderer remains responsive across reveals with terminal GPU acceleration off', async ({
    orcaPage
  }) => {
    test.setTimeout(180_000)
    const ids = await setUpStreamingWorkspace(orcaPage, 'off')
    await expectRendererSurvivesReveals(orcaPage, ids, 'software-terminal')
  })

  test('a plain GPU process crash during a settled reveal does not freeze the renderer', async ({
    orcaPage,
    electronApp
  }) => {
    test.setTimeout(240_000)
    await requireGpuCapability(orcaPage, electronApp)
    const ids = await setUpStreamingWorkspace(orcaPage, 'on')
    for (let round = 0; round < 3; round += 1) {
      await revealWorktree(orcaPage, ids, round)
      await new Promise((resolve) => setTimeout(resolve, 40))
      const [pid] = await gpuPids(electronApp)
      if (pid === undefined) {
        throw new Error('GPU process disappeared before the test kill')
      }
      process.kill(pid, 'SIGKILL')
      await new Promise((resolve) => setTimeout(resolve, 2_000))
      expect(isHealthy(await probeRenderer(orcaPage))).toBe(true)
    }
  })

  for (const mode of ['on', 'off'] as const) {
    test(`suspending a GPU without a prior failure does not trigger recovery (terminal GPU ${mode})`, async ({
      orcaPage,
      electronApp
    }) => {
      test.setTimeout(240_000)
      test.skip(
        process.platform === 'win32',
        'No safe native Windows suspension adapter is installed'
      )
      await requireGpuCapability(orcaPage, electronApp)
      const ids = await setUpStreamingWorkspace(orcaPage, mode)
      const [gpuPid] = await gpuPids(electronApp)
      if (gpuPid === undefined) {
        throw new Error('GPU process disappeared before suspension')
      }
      setProcessSuspended(gpuPid, true)
      try {
        await new Promise((resolve) => setTimeout(resolve, 12_000))
        expect(await gpuPids(electronApp)).toContain(gpuPid)
      } finally {
        resumeIfAlive(gpuPid)
      }
      expect(isHealthy(await waitForHealthyRenderer(orcaPage))).toBe(true)
      await expectRendererSurvivesReveals(orcaPage, ids, `resumed-mode=${mode}`)
    })
  }
})
