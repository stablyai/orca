import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PROTOCOL_VERSION } from '../../src/main/daemon/types'
import type { RuntimeStatus } from '../../src/shared/runtime-types'
import { expect, test } from './helpers/orca-app'
import {
  createHostCliTerminal,
  proveSameLivePty,
  readHostTerminalInventory,
  writeRetentionFixture
} from './helpers/host-created-terminal-retention-oracle'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import {
  processIdentityIsAlive,
  processIdentityLiveness,
  recordProcessIdentity
} from './helpers/daemon-generation-processes'

type RendererIdentity = {
  crashed: boolean
  destroyed: boolean
  marker: string | null
  pid: number
  url: string
  webContentsId: number
}

const INCIDENT_OBSERVATION_MS = 12_000
const INCIDENT_CHECKPOINT_MS = 3_000

function readDaemonPid(userDataDir: string): number {
  const raw = readFileSync(
    path.join(userDataDir, 'daemon', `daemon-v${PROTOCOL_VERSION}.pid`),
    'utf8'
  )
  const parsed = JSON.parse(raw) as { pid?: unknown }
  if (typeof parsed.pid !== 'number') {
    throw new Error(`Daemon pid file did not contain a numeric pid: ${raw}`)
  }
  return parsed.pid
}

async function readOffscreenRenderer(
  app: Awaited<ReturnType<typeof launchHeadlessPairedRuntimeHost>>['app'],
  pageId: string,
  readMarker = true
): Promise<RendererIdentity | null> {
  return app.evaluate(
    async ({ BrowserWindow }, { readMarker, targetPageId }) => {
      const win = BrowserWindow.getAllWindows().find((candidate) =>
        candidate.webContents.getURL().includes(targetPageId)
      )
      if (!win) {
        return null
      }
      let marker: string | null = null
      if (readMarker && !win.webContents.isCrashed() && !win.webContents.isDestroyed()) {
        try {
          marker = (await win.webContents.executeJavaScript(
            "document.querySelector('#sta-5228-marker')?.textContent ?? null"
          )) as string | null
        } catch {}
      }
      return {
        crashed: win.webContents.isCrashed(),
        destroyed: win.webContents.isDestroyed(),
        marker,
        pid: win.webContents.getOSProcessId(),
        url: win.webContents.getURL(),
        webContentsId: win.webContents.id
      }
    },
    { readMarker, targetPageId: pageId }
  )
}

test('STA-5228 renderer death keeps headless runtime and PTYs alive', async ({ testRepoPath }) => {
  test.setTimeout(180_000)

  const scratch = mkdtempSync(path.join(os.tmpdir(), 'orca-sta-5228-'))
  const fixturePath = writeRetentionFixture(scratch)
  const sinkPath = path.join(scratch, 'pty.log')
  let host: Awaited<ReturnType<typeof launchHeadlessPairedRuntimeHost>> | null = null
  try {
    const launchedHost = await launchHeadlessPairedRuntimeHost()
    host = launchedHost
    const userDataDir = await launchedHost.app.evaluate(({ app }) => app.getPath('userData'))
    const mainPid = await launchedHost.app.evaluate(() => process.pid)
    const daemonPid = readDaemonPid(userDataDir)
    const mainIdentity = await recordProcessIdentity(mainPid)
    const daemonIdentity = await recordProcessIdentity(daemonPid)
    expect(
      await launchedHost.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
    ).toBe(0)
    const beforeStatus = await launchedHost.client.call<RuntimeStatus>('status.get')
    const added = await launchedHost.client.call<{ repo: { id: string } }>('repo.add', {
      path: testRepoPath,
      kind: 'git'
    })
    const listed = await launchedHost.client.call<{ worktrees: { id: string }[] }>(
      'worktree.list',
      {
        repo: `id:${added.result.repo.id}`
      }
    )
    const worktreeId = listed.result.worktrees[0]?.id
    if (!worktreeId) {
      throw new Error('Headless host did not list the seeded worktree')
    }
    const call = async <TResult>(method: string, params: unknown): Promise<TResult> =>
      (await launchedHost.client.call<TResult>(method, params)).result
    const terminalA = await createHostCliTerminal(call, worktreeId, fixturePath, sinkPath)
    const terminalB = await createHostCliTerminal(
      call,
      worktreeId,
      fixturePath,
      path.join(scratch, 'pty-b.log')
    )
    const baselineInventory = await readHostTerminalInventory(call, worktreeId)
    expect(baselineInventory.ptyIdByTabId[terminalA.tabId]).toBe(terminalA.ptyId)
    expect(baselineInventory.ptyIdByTabId[terminalB.tabId]).toBe(terminalB.ptyId)
    const proveHostState = async (marker: string): Promise<void> => {
      const status = await launchedHost.client.call<RuntimeStatus>('status.get')
      const processLiveness = await processIdentityLiveness([mainIdentity, daemonIdentity])
      expect(await launchedHost.app.evaluate(() => process.pid)).toBe(mainPid)
      expect(processLiveness.get(mainPid)).toBe(true)
      expect(status.result.runtimeId).toBe(beforeStatus.result.runtimeId)
      expect(readDaemonPid(userDataDir)).toBe(daemonPid)
      expect(processLiveness.get(daemonPid)).toBe(true)
      const inventory = await readHostTerminalInventory(call, worktreeId)
      expect(inventory.terminalSurfaces).toEqual(baselineInventory.terminalSurfaces)
      await proveSameLivePty(call, terminalA, `${marker}_A`)
      await proveSameLivePty(call, terminalB, `${marker}_B`)
    }
    await proveHostState('BEFORE_RENDERER_KILL')

    const pageId = `sta-5228-${Date.now()}`
    const markerUrl = `data:text/html,${encodeURIComponent(
      `<p id="sta-5228-marker">${pageId}</p>`
    )}`
    await launchedHost.client.call<{ browserPageId: string }>('browser.tabCreate', {
      url: markerUrl,
      worktree: `id:${worktreeId}`
    })
    const rendererObservation = { value: null as RendererIdentity | null }
    await expect
      .poll(
        async () => {
          rendererObservation.value = await readOffscreenRenderer(launchedHost.app, pageId)
          return rendererObservation.value
        },
        {
          timeout: 30_000,
          message: 'Headless offscreen renderer never loaded the marker page'
        }
      )
      .toMatchObject({ marker: pageId, crashed: false, destroyed: false })
    const renderer = rendererObservation.value
    if (!renderer || renderer.pid <= 0) {
      throw new Error('Headless offscreen renderer did not expose an OS process identity')
    }
    expect(renderer.pid).not.toBe(mainPid)
    expect(renderer.pid).not.toBe(daemonPid)
    const rendererIdentity = await recordProcessIdentity(renderer.pid)

    const fencedRenderer = await readOffscreenRenderer(launchedHost.app, pageId)
    expect(fencedRenderer).toMatchObject({
      crashed: false,
      marker: pageId,
      pid: renderer.pid,
      webContentsId: renderer.webContentsId
    })
    expect(await processIdentityIsAlive(rendererIdentity)).toBe(true)
    if (process.platform === 'linux') {
      expect(readFileSync(path.join('/proc', String(renderer.pid), 'cmdline'), 'utf8')).toContain(
        '--type=renderer'
      )
    }
    let hostClosed = false
    launchedHost.app.once('close', () => {
      hostClosed = true
    })
    await launchedHost.app.evaluate(
      ({ BrowserWindow }, expected) => {
        const win = BrowserWindow.getAllWindows().find(
          (candidate) => candidate.webContents.id === expected.webContentsId
        )
        if (
          !win ||
          !win.webContents.getURL().includes(expected.pageId) ||
          win.webContents.getOSProcessId() !== expected.pid
        ) {
          throw new Error('Offscreen renderer identity changed before the fault')
        }
        const probe = { details: null as Electron.RenderProcessGoneDetails | null }
        ;(globalThis as typeof globalThis & { __sta5228Probe?: typeof probe }).__sta5228Probe =
          probe
        win.webContents.once('render-process-gone', (_event, details) => {
          probe.details = details
        })
        setTimeout(() => win.webContents.forcefullyCrashRenderer(), 0)
      },
      { pageId, pid: renderer.pid, webContentsId: renderer.webContentsId }
    )

    await expect
      .poll(
        () =>
          launchedHost.app.evaluate(
            () =>
              (
                globalThis as typeof globalThis & {
                  __sta5228Probe?: { details: Electron.RenderProcessGoneDetails | null }
                }
              ).__sta5228Probe?.details ?? null
          ),
        {
          timeout: 15_000,
          message: 'Exact offscreen renderer fault produced no process-gone event'
        }
      )
      .toMatchObject({ reason: 'killed' })

    await expect
      .poll(() => processIdentityIsAlive(rendererIdentity), {
        message: 'The exact renderer process remained alive after its WebContents crashed'
      })
      .toBe(false)

    await proveHostState('AFTER_RENDERER_KILL')
    const observationDeadline = Date.now() + INCIDENT_OBSERVATION_MS
    let checkpoint = 0
    do {
      await new Promise((resolve) => setTimeout(resolve, INCIDENT_CHECKPOINT_MS))
      expect(
        hostClosed,
        'headless main exited during the incident-derived observation window'
      ).toBe(false)
      await proveHostState(`STABILITY_${checkpoint++}`)
    } while (Date.now() < observationDeadline)

    const afterRenderer = await readOffscreenRenderer(launchedHost.app, pageId, false)
    console.log('[STA-5228] renderer lifecycle snapshot', {
      afterRenderer,
      beforeRenderer: renderer,
      daemonPid,
      mainPid,
      ptyIds: [terminalA.ptyId, terminalB.ptyId],
      runtimeId: beforeStatus.result.runtimeId,
      stabilityCheckpoints: checkpoint
    })
  } finally {
    try {
      await host?.dispose()
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }
})
