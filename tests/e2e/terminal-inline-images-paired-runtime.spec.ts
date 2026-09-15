import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { RuntimeMobileSessionTabsResult } from '../../src/shared/runtime-types'
import { toRemoteRuntimePtyId } from '../../src/shared/remote-runtime-pty-id'
import { toWebTerminalSurfaceTabId } from '../../src/shared/terminal-surface-id'
import { expect, test } from './helpers/orca-app'
import {
  assertInlineImagePixels,
  enableInlineImages,
  inlineImageProducer,
  readInlineImageState
} from './helpers/terminal-inline-image-proof'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import {
  createHostCliTerminal,
  createRetentionFixtureDirectory,
  readSink
} from './helpers/host-created-terminal-retention-oracle'
import {
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'

async function callRuntime<T>(
  client: PairedElectronClient,
  method: string,
  params: unknown
): Promise<T> {
  return client.page.evaluate(
    async ({ selector, method, params }) => {
      const response = await window.api.runtimeEnvironments.call({
        selector,
        method,
        params,
        timeoutMs: 30_000
      })
      if (!response.ok) {
        throw new Error(`${response.error.code}: ${response.error.message}`)
      }
      return response.result
    },
    { selector: client.environmentId, method, params }
  ) as Promise<T>
}

async function expectProtocolPixels(
  client: PairedElectronClient,
  tabId: string,
  marker: string,
  screenshotPath: string
) {
  await expect
    .poll(
      () =>
        client.page.evaluate(
          (id) =>
            window.__paneManagers?.get(id)?.getActivePane()?.serializeAddon?.serialize() ?? '',
          tabId
        ),
      { timeout: 45_000 }
    )
    .toContain(`LIVE:${marker}:`)
  await assertInlineImagePixels(client.page, screenshotPath)
  await expect
    .poll(() => readInlineImageState(client.page))
    .toMatchObject({ images: 3, pending: 0, decoderBytes: 0 })
}

test('paired runtime paints inline images and resumes the same PTY after host restart', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(300_000)
  const scratch = createRetentionFixtureDirectory()
  const fixturePath = path.join(scratch, 'paired-inline-image-fixture.mjs')
  const sinkPath = path.join(scratch, 'fixture.log')
  const host = await launchHeadlessPairedRuntimeHost({ pinnedServePort: true })
  let client: PairedElectronClient | undefined
  let liveHandle: string | undefined
  try {
    const added = await host.client.call<{ repo: { id: string } }>('repo.add', {
      path: testRepoPath,
      kind: 'folder'
    })
    let worktreeId = ''
    await expect
      .poll(
        async () => {
          const listed = await host.client.call<{ worktrees: { id: string }[] }>('worktree.list', {
            repo: `id:${added.result.repo.id}`
          })
          worktreeId = listed.result.worktrees[0]?.id ?? ''
          return worktreeId
        },
        { timeout: 30_000 }
      )
      .not.toBe('')
    client = await launchPairedElectronClient(host.offer, testInfo, 'paired-inline-images')
    const viewer = client
    writeFileSync(
      fixturePath,
      [
        "import { appendFileSync } from 'node:fs'",
        'const record = line => appendFileSync(process.argv[2], line + "\\n")',
        'record(`READY:${process.pid}`)',
        'process.stdout.write(`READY:${process.pid}\\r\\n`)',
        `function emitImages() { ${inlineImageProducer()} }`,
        'let pending = ""',
        'process.stdin.setEncoding("utf8")',
        'process.stdin.on("data", data => {',
        'pending += data',
        'const lines = pending.split(/\\r\\n|\\r|\\n/)',
        'pending = lines.pop() ?? ""',
        'for (const line of lines) {',
        'if (line.startsWith("PING_")) { process.stdout.write(`PONG:${line}\\r\\n`); continue }',
        'if (!line.startsWith("IMAGES_")) continue',
        'record(`LIVE:${line}:${process.pid}`)',
        'emitImages()',
        'process.stdout.write(`LIVE:${line}:${process.pid}\\r\\n`)',
        '}})',
        'process.stdin.resume()'
      ].join('\n')
    )
    writeFileSync(sinkPath, '')
    const terminal = await createHostCliTerminal(
      (method, params) => callRuntime(viewer, method, params),
      worktreeId,
      fixturePath,
      sinkPath
    )
    liveHandle = terminal.handle
    const tabId = toWebTerminalSurfaceTabId(terminal.tabId)
    await expect
      .poll(
        () =>
          viewer.page.evaluate(
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
    await viewer.page.evaluate(
      ({ environmentId, worktreeId }) => {
        const state = window.__store?.getState()
        state?.setActiveView('terminal')
        state?.setActiveWorktree(worktreeId, `runtime:${environmentId}`)
      },
      { environmentId: viewer.environmentId, worktreeId }
    )
    const tab = viewer.page.locator(`[data-testid="sortable-tab"][data-tab-id="${tabId}"]`)
    await expect(tab).toBeVisible({ timeout: 60_000 })
    await tab.click()
    await expect
      .poll(() => viewer.page.evaluate((id) => window.__paneManagers?.has(id), tabId), {
        timeout: 60_000
      })
      .toBe(true)
    await enableInlineImages(viewer.page)
    await callRuntime(viewer, 'terminal.send', {
      terminal: liveHandle,
      text: 'IMAGES_BEFORE',
      enter: true
    })
    await expectProtocolPixels(
      viewer,
      tabId,
      'IMAGES_BEFORE',
      testInfo.outputPath('paired-images-before-restart.png')
    )
    const readyLines = readSink(sinkPath)
      .split(/\r?\n/)
      .filter((line) => line.startsWith('READY:'))
    expect(readyLines).toHaveLength(1)
    const initialHostPid = host.app.process().pid
    await host.restartServeProcess()
    expect(host.app.process().pid).not.toBe(initialHostPid)
    await expect
      .poll(
        async () => {
          const listed = await host.client.call<RuntimeMobileSessionTabsResult>(
            'session.tabs.list',
            { worktree: `id:${worktreeId}` }
          )
          const surface = listed.result.tabs.find(
            (t) =>
              t.type === 'terminal' &&
              t.parentTabId === terminal.tabId &&
              t.leafId === terminal.leafId &&
              t.ptyId === terminal.ptyId
          )
          if (surface?.type !== 'terminal' || surface.status !== 'ready' || !surface.terminal) {
            return false
          }
          liveHandle = surface.terminal
          return true
        },
        { timeout: 90_000 }
      )
      .toBe(true)
    await viewer.page.evaluate(
      ({ environmentId, worktreeId }) => {
        const state = window.__store?.getState()
        state?.setActiveWorktree(worktreeId, `runtime:${environmentId}`)
        state?.setActiveView('terminal')
      },
      { environmentId: viewer.environmentId, worktreeId }
    )
    await expect(tab).toBeVisible({ timeout: 60_000 })
    await tab.click()
    if (!liveHandle) {
      throw new Error('Replacement host did not publish a terminal handle')
    }
    const remotePtyId = toRemoteRuntimePtyId(liveHandle, viewer.environmentId)
    await expect
      .poll(
        () =>
          viewer.page.evaluate(
            (id) => window.__paneManagers?.get(id)?.getActivePane()?.container.dataset.ptyId,
            tabId
          ),
        { timeout: 60_000 }
      )
      .toBe(remotePtyId)
    // RPC success precedes renderer replay completion; wait for the real input transport.
    await expect
      .poll(
        async () => {
          return viewer.page.evaluate((id) => {
            const pane = window.__paneManagers?.get(id)?.getActivePane()
            if (!pane) {
              return false
            }
            if (pane.serializeAddon.serialize().includes('PONG:PING_REATTACHED')) {
              return true
            }
            pane.terminal.input('PING_REATTACHED\r', true)
            return false
          }, tabId)
        },
        { timeout: 30_000, intervals: [200, 500, 1000] }
      )
      .toBe(true)
    await expect
      .poll(
        async () => {
          try {
            await callRuntime(viewer, 'terminal.send', {
              terminal: liveHandle,
              text: 'IMAGES_AFTER',
              enter: true
            })
            return true
          } catch {
            return false
          }
        },
        { timeout: 60_000, intervals: [500, 1000, 2000] }
      )
      .toBe(true)
    await expectProtocolPixels(
      viewer,
      tabId,
      'IMAGES_AFTER',
      testInfo.outputPath('paired-images-after-restart.png')
    )
    expect(readSink(sinkPath)).toContain(`LIVE:IMAGES_AFTER:${terminal.pid}`)
    expect(
      readSink(sinkPath)
        .split(/\r?\n/)
        .filter((line) => line.startsWith('READY:'))
    ).toEqual(readyLines)
    expect(await viewer.getDirectSshAttemptTargetIds()).toEqual([])
  } finally {
    if (client && liveHandle) {
      await callRuntime(client, 'terminal.closeTab', { terminal: liveHandle }).catch(
        () => undefined
      )
    }
    await client?.dispose()
    await host.dispose()
    rmSync(scratch, { recursive: true, force: true })
  }
})
