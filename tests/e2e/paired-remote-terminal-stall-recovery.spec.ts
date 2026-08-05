import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { PNG } from 'pngjs'
import type { RuntimeTerminalRead } from '../../src/shared/runtime-types'
import { toWebTerminalSurfaceTabId } from '../../src/shared/terminal-surface-id'
import { expect, test } from './helpers/orca-app'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedWebClient
} from './helpers/paired-electron-client'
import { getTerminalContent, waitForActivePanePtyId } from './helpers/terminal'

const MIN_EXHAUSTED_ACK_BYTES = 400 * 1024
const PUBLICATION_DEADLINE_MS = 10_000
const scratch = mkdtempSync(path.join(os.tmpdir(), 'orca-paired-stalled-stream-'))
const fixturePath = path.join(scratch, 'stalled-stream-terminal.mjs')
writeFileSync(
  fixturePath,
  [
    "process.stdout.write('PAIRED_STALL_READY\\r\\n')",
    "process.stdin.setEncoding('utf8')",
    "let pending = ''",
    "process.stdin.on('data', (data) => {",
    '  pending += data',
    '  const commands = pending.split(/\\r\\n|\\r|\\n/)',
    '  pending = commands.pop() ?? ""',
    '  for (const input of commands) {',
    "    if (input === 'GO') {",
    "      for (let row = 0; row < 16_000; row += 1) process.stdout.write(`flood-${row}-${'x'.repeat(80)}\\r\\n`)",
    "      process.stdout.write('HOST_FLOOD_COMPLETE\\r\\n')",
    '      continue',
    '    }',
    "    process.stdout.write(`\\x1b[48;2;24;96;144mLIVE:${input}${' '.repeat(48)}\\x1b[0m\\r\\n`)",
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

async function callRuntime<TResult>(page: Page, method: string, params: unknown): Promise<TResult> {
  return page.evaluate(
    async ({ method, params }) => {
      const response = await window.api.runtime.call({ method, params })
      if (!response.ok) {
        throw new Error(`${response.error.code}: ${response.error.message}`)
      }
      return response.result
    },
    { method, params }
  ) as Promise<TResult>
}

type AppResourceProxies = {
  gpuCpuPercent: number
  gpuIdleWakeupsPerSecond: number
  processCount: number
  totalCpuPercent: number
  totalIdleWakeupsPerSecond: number
}

async function getAppResourceProxies(
  electronApp: ElectronApplication
): Promise<AppResourceProxies> {
  return electronApp.evaluate(({ app }) => {
    const metrics = app.getAppMetrics()
    const gpu = metrics.find((metric) => metric.type === 'GPU')
    return {
      gpuCpuPercent: gpu?.cpu.percentCPUUsage ?? 0,
      gpuIdleWakeupsPerSecond: gpu?.cpu.idleWakeupsPerSecond ?? 0,
      processCount: metrics.length,
      totalCpuPercent: metrics.reduce((total, metric) => total + metric.cpu.percentCPUUsage, 0),
      totalIdleWakeupsPerSecond: metrics.reduce(
        (total, metric) => total + metric.cpu.idleWakeupsPerSecond,
        0
      )
    }
  })
}

async function minimizeHeadedHost(electronApp: ElectronApplication, page: Page): Promise<void> {
  const host = await electronApp.browserWindow(page)
  await host.evaluate((window) => window.minimize())
  await expect
    .poll(() =>
      host.evaluate((window) => ({
        backgroundThrottling: window.webContents.getBackgroundThrottling(),
        minimized: window.isMinimized(),
        visible: window.isVisible()
      }))
    )
    .toEqual({ backgroundThrottling: true, minimized: true, visible: false })
}

async function restoreHeadedHost(electronApp: ElectronApplication, page: Page): Promise<void> {
  const host = await electronApp.browserWindow(page)
  await host.evaluate((window) => {
    window.restore()
    window.show()
    window.focus()
  })
  await expect
    .poll(() =>
      host.evaluate((window) => ({
        backgroundThrottling: window.webContents.getBackgroundThrottling(),
        minimized: window.isMinimized(),
        visible: window.isVisible()
      }))
    )
    .toEqual({ backgroundThrottling: true, minimized: false, visible: true })
  await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe('visible')
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  )
}

async function showHeadedClient(electronApp: ElectronApplication, page: Page): Promise<void> {
  const clientWindow = await electronApp.browserWindow(page)
  await clientWindow.evaluate((window) => {
    window.show()
    window.focus()
  })
  await expect.poll(() => clientWindow.evaluate((window) => window.isVisible())).toBe(true)
}

function countForegroundPixels(buffer: Buffer): number {
  const image = PNG.sync.read(buffer)
  const buckets = new Map<string, { count: number; red: number; green: number; blue: number }>()
  for (let offset = 0; offset < image.data.length; offset += 4) {
    if ((image.data[offset + 3] ?? 0) < 128) {
      continue
    }
    const red = image.data[offset] ?? 0
    const green = image.data[offset + 1] ?? 0
    const blue = image.data[offset + 2] ?? 0
    const key = `${red >> 3},${green >> 3},${blue >> 3}`
    const bucket = buckets.get(key) ?? { count: 0, red, green, blue }
    bucket.count += 1
    buckets.set(key, bucket)
  }
  const background = [...buckets.values()].sort((a, b) => b.count - a.count)[0]
  if (!background) {
    return 0
  }
  let foregroundPixels = 0
  for (let offset = 0; offset < image.data.length; offset += 4) {
    if ((image.data[offset + 3] ?? 0) < 128) {
      continue
    }
    const distance =
      Math.abs((image.data[offset] ?? 0) - background.red) +
      Math.abs((image.data[offset + 1] ?? 0) - background.green) +
      Math.abs((image.data[offset + 2] ?? 0) - background.blue)
    if (distance > 48) {
      foregroundPixels += 1
    }
  }
  return foregroundPixels
}

function countVisualMarkerPixels(buffer: Buffer): number {
  const image = PNG.sync.read(buffer)
  let count = 0
  for (let offset = 0; offset < image.data.length; offset += 4) {
    const red = image.data[offset] ?? 0
    const green = image.data[offset + 1] ?? 0
    const blue = image.data[offset + 2] ?? 0
    if (
      (image.data[offset + 3] ?? 0) >= 245 &&
      blue >= 100 &&
      blue - red >= 50 &&
      blue - green >= 20 &&
      green - red >= 10
    ) {
      count += 1
    }
  }
  return count
}

async function findHostPaneWithMarker(
  page: Page,
  marker: string
): Promise<{ paneId: number; ptyId: string; tabId: string }> {
  let target: { paneId: number; ptyId: string; tabId: string } | null = null
  await expect
    .poll(
      async () => {
        target = await page.evaluate((expectedMarker) => {
          for (const [tabId, manager] of window.__paneManagers?.entries() ?? []) {
            for (const pane of manager.getPanes?.() ?? []) {
              const content = pane.serializeAddon?.serialize?.() ?? ''
              const ptyId = pane.container?.dataset?.ptyId
              if (content.includes(expectedMarker) && ptyId) {
                return { paneId: pane.id, ptyId, tabId }
              }
            }
          }
          return null
        }, marker)
        return target !== null
      },
      { timeout: 30_000, message: 'host renderer never mirrored the paired terminal marker' }
    )
    .toBe(true)
  if (!target) {
    throw new Error('Host terminal marker target disappeared')
  }
  return target
}

test('restarts one ACK-starved paired terminal stream without replacing its PTY @headful', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  test.setTimeout(150_000)
  const liveMarker = `PAIRED_STALL_RECOVERED_${Date.now()}`
  const worktree = await orcaPage.evaluate(() => {
    const state = window.__store?.getState()
    const id = state?.activeWorktreeId
    const active = state?.allWorktrees().find((candidate) => candidate.id === id)
    if (!active) {
      throw new Error('Headed host did not select its seeded worktree')
    }
    return { id: active.id }
  })
  const noClientResources = await getAppResourceProxies(electronApp)
  const offer = await createRuntimeDesktopPairingOffer(orcaPage)
  const client = await launchPairedWebClient(electronApp, offer, {
    disableRemoteTerminalStallRecovery:
      process.env.ORCA_E2E_DISABLE_REMOTE_TERMINAL_STALL_RECOVERY === '1'
  })
  let observer: Awaited<ReturnType<typeof launchPairedWebClient>> | null = null
  let terminal: string | null = null
  try {
    await expect
      .poll(
        () =>
          client.page.evaluate(
            (worktreeId) =>
              window.__store
                ?.getState()
                .allWorktrees()
                .some((candidate) => candidate.id === worktreeId),
            worktree.id
          ),
        { timeout: 30_000 }
      )
      .toBe(true)
    const observerOffer = await createRuntimeDesktopPairingOffer(orcaPage)
    observer = await launchPairedWebClient(electronApp, observerOffer)
    await showHeadedClient(electronApp, client.page)
    await showHeadedClient(electronApp, observer.page)
    await expect
      .poll(
        () =>
          observer?.page.evaluate(
            (worktreeId) =>
              window.__store
                ?.getState()
                .allWorktrees()
                .some((candidate) => candidate.id === worktreeId),
            worktree.id
          ),
        { timeout: 30_000 }
      )
      .toBe(true)
    const connectedIdleResources = await getAppResourceProxies(electronApp)
    await minimizeHeadedHost(electronApp, orcaPage)
    const createStartedAt = performance.now()
    const created = await callRuntime<{
      tab: { id: string; parentTabId: string; terminal: string | null }
    }>(client.page, 'session.tabs.createTerminal', {
      worktree: `id:${worktree.id}`,
      command: fixtureCommand(),
      activate: false,
      select: false,
      navigation: 'caller'
    })
    const createLatencyMs = performance.now() - createStartedAt
    expect(createLatencyMs).toBeLessThan(PUBLICATION_DEADLINE_MS)
    terminal = created.tab.terminal
    if (!terminal) {
      throw new Error('Paired runtime did not publish the stalled-stream fixture')
    }
    const webTabId = toWebTerminalSurfaceTabId(created.tab.parentTabId)
    await expect
      .poll(
        () =>
          client.page.evaluate(
            ({ tabId, worktreeId }) =>
              (window.__store?.getState().tabsByWorktree[worktreeId] ?? []).some(
                (tab) => tab.id === tabId
              ),
            { tabId: webTabId, worktreeId: worktree.id }
          ),
        { timeout: 30_000 }
      )
      .toBe(true)
    await expect
      .poll(
        () =>
          observer?.page.evaluate(
            ({ tabId, worktreeId }) =>
              (window.__store?.getState().tabsByWorktree[worktreeId] ?? []).some(
                (tab) => tab.id === tabId
              ),
            { tabId: webTabId, worktreeId: worktree.id }
          ),
        { timeout: 30_000 }
      )
      .toBe(true)
    await expect
      .poll(
        () =>
          orcaPage.evaluate(
            ({ tabId, worktreeId }) =>
              (window.__store?.getState().tabsByWorktree[worktreeId] ?? []).some(
                (tab) => tab.id === tabId
              ),
            { tabId: created.tab.parentTabId, worktreeId: worktree.id }
          ),
        { timeout: 30_000 }
      )
      .toBe(true)
    expect(
      (
        await callRuntime<{ tabs: { terminal?: string | null }[] }>(
          client.page,
          'session.tabs.list',
          { worktree: `id:${worktree.id}` }
        )
      ).tabs.some((candidate) => candidate.terminal === terminal),
      'authoritative inventory dropped the terminal before ACK starvation'
    ).toBe(true)
    await client.page.evaluate(
      (worktreeId) => window.__store?.getState().setActiveWorktree(worktreeId),
      worktree.id
    )
    const tab = client.page.locator(`[data-testid="sortable-tab"][data-tab-id="${webTabId}"]`)
    await expect(tab).toBeVisible({ timeout: 30_000 })
    await tab.click()
    const originalPtyId = await waitForActivePanePtyId(client.page, 30_000)
    await expect
      .poll(() => getTerminalContent(client.page), { timeout: 30_000 })
      .toContain('PAIRED_STALL_READY')
    await observer.page.evaluate(
      (worktreeId) => window.__store?.getState().setActiveWorktree(worktreeId),
      worktree.id
    )
    const observerTab = observer.page.locator(
      `[data-testid="sortable-tab"][data-tab-id="${webTabId}"]`
    )
    await expect(observerTab).toBeVisible({ timeout: 30_000 })
    await observerTab.click()
    const observerOriginalPtyId = await waitForActivePanePtyId(observer.page, 30_000)
    expect(observerOriginalPtyId.split('@@').at(-1)).toBe(originalPtyId.split('@@').at(-1))
    await expect
      .poll(() => getTerminalContent(observer.page), { timeout: 30_000 })
      .toContain('PAIRED_STALL_READY')

    await client.page.evaluate((target) => {
      const gate = (
        window as typeof window & {
          __remoteTerminalMultiplexAckGate?: { hold: (terminals: string[]) => void }
        }
      ).__remoteTerminalMultiplexAckGate
      if (!gate) {
        throw new Error('Remote terminal multiplex ACK gate is unavailable')
      }
      gate.hold([target])
    }, terminal)
    const textarea = client.page.locator('.xterm-helper-textarea:visible').first()
    await textarea.focus()
    await client.page.keyboard.type('GO')
    await client.page.keyboard.press('Enter')

    await expect
      .poll(
        () =>
          client.page.evaluate(() => {
            const gate = (
              window as typeof window & {
                __remoteTerminalMultiplexAckGate?: {
                  snapshot: () => { heldAckChars: number }
                }
              }
            ).__remoteTerminalMultiplexAckGate
            return gate?.snapshot().heldAckChars ?? 0
          }),
        { timeout: 30_000 }
      )
      .toBeGreaterThan(MIN_EXHAUSTED_ACK_BYTES)
    await expect
      .poll(
        async () => {
          const result = await callRuntime<{ terminal: RuntimeTerminalRead }>(
            client.page,
            'terminal.read',
            { terminal }
          )
          return result.terminal.tail.join('\n').includes('HOST_FLOOD_COMPLETE')
        },
        { timeout: 30_000 }
      )
      .toBe(true)

    const beforeInput = await callRuntime<{ terminal: RuntimeTerminalRead }>(
      client.page,
      'terminal.read',
      { terminal }
    )
    const sent = await callRuntime<{ send: { accepted: boolean } }>(client.page, 'terminal.send', {
      terminal,
      text: liveMarker,
      enter: true,
      client: { id: 'paired-stalled-stream-e2e', type: 'desktop' }
    })
    expect(sent.send.accepted).toBe(true)
    await expect
      .poll(
        async () => {
          const result = await callRuntime<{ terminal: RuntimeTerminalRead }>(
            client.page,
            'terminal.read',
            { terminal }
          )
          return Number(result.terminal.latestCursor)
        },
        { timeout: 30_000 }
      )
      .toBeGreaterThan(Number(beforeInput.terminal.latestCursor))
    expect(await getTerminalContent(client.page)).not.toContain(liveMarker)
    expect(
      await client.page.evaluate(
        ({ target, text }) => {
          const gate = (
            window as typeof window & {
              __remoteTerminalMultiplexAckGate?: {
                sendInput: (terminal: string, text: string) => number
              }
            }
          ).__remoteTerminalMultiplexAckGate
          return gate?.sendInput(target, text) ?? 0
        },
        { target: terminal, text: '\r' }
      )
    ).toBe(1)

    await expect
      .poll(() => getTerminalContent(client.page), { timeout: 30_000 })
      .toContain(`LIVE:${liveMarker}`)
    expect(await waitForActivePanePtyId(client.page, 30_000)).toBe(originalPtyId)
    await expect(tab).toHaveAttribute('data-active', 'true')
    await expect
      .poll(() => getTerminalContent(observer.page), { timeout: 30_000 })
      .toContain(`LIVE:${liveMarker}`)
    expect(await waitForActivePanePtyId(observer.page, 30_000)).toBe(observerOriginalPtyId)
    expect(
      (
        await callRuntime<{ tabs: { terminal?: string | null }[] }>(
          client.page,
          'session.tabs.list',
          { worktree: `id:${worktree.id}` }
        )
      ).tabs.some((candidate) => candidate.terminal === terminal),
      'authoritative inventory dropped the terminal during ACK recovery'
    ).toBe(true)

    await restoreHeadedHost(electronApp, orcaPage)
    await orcaPage.evaluate(
      (worktreeId) => window.__store?.getState().setActiveWorktree(worktreeId),
      worktree.id
    )
    const hostTab = orcaPage.locator(
      `[data-testid="sortable-tab"][data-tab-id="${created.tab.parentTabId}"]`
    )
    await expect(hostTab).toBeVisible({ timeout: 30_000 })
    await hostTab.click()
    const hostPane = await findHostPaneWithMarker(orcaPage, `LIVE:${liveMarker}`)
    expect(hostPane.tabId).toBe(created.tab.parentTabId)
    await orcaPage.evaluate(({ paneId, tabId }) => {
      const manager = window.__paneManagers?.get(tabId)
      manager?.setActivePane?.(paneId, { focus: true })
    }, hostPane)
    await expect
      .poll(() => getTerminalContent(orcaPage), { timeout: 30_000 })
      .toContain(`LIVE:${liveMarker}`)
    const restoredTerminalScreenshot = await orcaPage
      .locator(
        `[data-terminal-tab-id="${hostPane.tabId}"] .pane[data-pane-id="${hostPane.paneId}"] .xterm-screen`
      )
      .screenshot({ animations: 'disabled' })
    await testInfo.attach('host-terminal-after-create-restore', {
      body: restoredTerminalScreenshot,
      contentType: 'image/png'
    })
    expect(
      countVisualMarkerPixels(restoredTerminalScreenshot),
      'host terminal marker did not repaint after the background publication toggle'
    ).toBeGreaterThan(500)
    expect(
      (
        await callRuntime<{ tabs: { terminal?: string | null }[] }>(
          client.page,
          'session.tabs.list',
          { worktree: `id:${worktree.id}` }
        )
      ).tabs.some((candidate) => candidate.terminal === terminal),
      'authoritative inventory dropped the terminal while restoring the host'
    ).toBe(true)

    await minimizeHeadedHost(electronApp, orcaPage)
    await showHeadedClient(electronApp, observer.page)

    const authoritativeInventory = await callRuntime<{
      tabs: { id: string; parentTabId?: string; terminal?: string | null }[]
    }>(client.page, 'session.tabs.list', { worktree: `id:${worktree.id}` })
    const authoritativeTab = authoritativeInventory.tabs.find(
      (candidate) => candidate.terminal === terminal
    )
    if (!authoritativeTab) {
      throw new Error(
        `Paired terminal was absent from authoritative inventory before close: ${JSON.stringify(
          authoritativeInventory.tabs.map((candidate) => ({
            id: candidate.id,
            parentTabId: candidate.parentTabId,
            terminal: candidate.terminal
          }))
        )}`
      )
    }
    const closeStartedAt = performance.now()
    await callRuntime(client.page, 'session.tabs.close', {
      worktree: `id:${worktree.id}`,
      tabId: authoritativeTab.id,
      reason: 'user',
      navigation: 'caller'
    })
    const closeLatencyMs = performance.now() - closeStartedAt
    expect(closeLatencyMs).toBeLessThan(PUBLICATION_DEADLINE_MS)
    await expect
      .poll(
        () =>
          Promise.all([
            orcaPage.evaluate(
              ({ tabId, worktreeId }) =>
                (window.__store?.getState().tabsByWorktree[worktreeId] ?? []).some(
                  (candidate) => candidate.id === tabId
                ),
              { tabId: created.tab.parentTabId, worktreeId: worktree.id }
            ),
            client.page.evaluate(
              ({ tabId, worktreeId }) =>
                (window.__store?.getState().tabsByWorktree[worktreeId] ?? []).some(
                  (candidate) => candidate.id === tabId
                ),
              { tabId: webTabId, worktreeId: worktree.id }
            ),
            observer.page.evaluate(
              ({ tabId, worktreeId }) =>
                (window.__store?.getState().tabsByWorktree[worktreeId] ?? []).some(
                  (candidate) => candidate.id === tabId
                ),
              { tabId: webTabId, worktreeId: worktree.id }
            )
          ]),
        { timeout: 30_000 }
      )
      .toEqual([false, false, false])
    terminal = null

    await restoreHeadedHost(electronApp, orcaPage)
    const restoredHostScreenshot = await orcaPage.screenshot({ fullPage: true })
    expect(
      countForegroundPixels(restoredHostScreenshot),
      'host compositor remained blank after the background close toggle'
    ).toBeGreaterThan(1_000)
    await testInfo.attach('host-window-after-close-restore', {
      body: restoredHostScreenshot,
      contentType: 'image/png'
    })

    const afterPublicationResources = await getAppResourceProxies(electronApp)
    const evidencePath = test.info().outputPath('publication-evidence.json')
    writeFileSync(
      evidencePath,
      `${JSON.stringify(
        {
          afterPublicationResources,
          closeLatencyMs,
          connectedIdleResources,
          createLatencyMs,
          hostMinimizedDuringCreateAndClose: true,
          hostRestoredAfterEachPublication: true,
          noClientResources
        },
        null,
        2
      )}\n`
    )
    await test.info().attach('publication-evidence', {
      contentType: 'application/json',
      path: evidencePath
    })
  } finally {
    await client.page
      .evaluate(() => {
        ;(
          window as typeof window & {
            __remoteTerminalMultiplexAckGate?: { release: () => void }
          }
        ).__remoteTerminalMultiplexAckGate?.release()
      })
      .catch(() => undefined)
    await observer?.dispose()
    if (terminal) {
      await callRuntime(client.page, 'terminal.closeTab', { terminal }).catch(() => undefined)
    }
    await client.dispose()
  }
})
