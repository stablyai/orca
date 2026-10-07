/**
 * A phone subscribing to an idle terminal after a relaunch must get its first snapshot on its grid.
 *
 * After a relaunch the daemon PTY is reattached with no host model, and an idle program never
 * paints a byte that would hydrate one. With the pane hidden behind another tab, the host used to
 * serve the pane's desktop-sized screen, and the phone gave up after three mismatched frames.
 *
 * Run:
 *   npx playwright test tests/e2e/mobile-subscribe-idle-hidden-pane-fit.spec.ts \
 *     --config tests/playwright.config.ts --project electron-headless --workers=1
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { TEST_REPO_PATH_FILE } from './global-setup'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import {
  execInTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'
import { ensureTerminalVisible, waitForSessionReady } from './helpers/store'
import { createRuntimeDesktopPairingOffer } from './helpers/paired-electron-client'
import { decodePairingOffer } from '../../src/shared/pairing'
import {
  sendRemoteRuntimeRequest,
  subscribeRemoteRuntimeRequest
} from '../../src/shared/remote-runtime-client'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson
} from '../../src/shared/terminal-stream-protocol'

const PHONE = { cols: 47, rows: 40 }

function writeIdleProgram(scriptPath: string): void {
  mkdirSync(path.dirname(scriptPath), { recursive: true })
  writeFileSync(
    scriptPath,
    [
      "process.stdout.write('A'.repeat(120) + '\\r\\nIDLE_READY')",
      'process.stdin.resume()',
      ''
    ].join('\n')
  )
}

async function paneGrid(page: Page, ptyId: string) {
  return page.evaluate((ptyId) => {
    for (const manager of window.__paneManagers?.values() ?? []) {
      const pane = manager
        .getPanes?.()
        .find((candidate) => candidate.container.dataset.ptyId === ptyId)
      if (pane) {
        return {
          cols: pane.terminal.cols,
          rows: pane.terminal.rows,
          visible: pane.container.getBoundingClientRect().width > 0,
          content: pane.serializeAddon.serialize()
        }
      }
    }
    return null
  }, ptyId)
}

async function findRestoredTabForPty(page: Page, ptyId: string): Promise<string | null> {
  return page.evaluate((ptyId) => {
    const layouts = window.__store?.getState().terminalLayoutsByTabId ?? {}
    for (const [tabId, layout] of Object.entries(layouts)) {
      if (Object.values(layout.ptyIdsByLeafId ?? {}).includes(ptyId)) {
        return tabId
      }
    }
    return null
  }, ptyId)
}

async function hideBehindNewTab(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = window.__store
    const worktreeId = store?.getState().activeWorktreeId
    if (!store || !worktreeId) {
      throw new Error('Store unavailable')
    }
    const tab = store.getState().createTab(worktreeId, undefined, undefined, { activate: true })
    store.getState().setActiveTab(tab.id)
  })
}

test('phone subscribe to an idle relaunched terminal behind another tab fits the phone', async (// oxlint-disable-next-line no-empty-pattern -- This restart test owns both app launches.
{}, testInfo) => {
  test.setTimeout(240_000)
  test.skip(process.platform === 'win32', 'The idle fixture is launched from a POSIX shell')
  const repoPath = readFileSync(TEST_REPO_PATH_FILE, 'utf8').trim()
  test.skip(!repoPath || !existsSync(repoPath), 'Global setup did not produce a seeded test repo')
  const scriptPath = testInfo.outputPath('idle-program.mjs')
  writeIdleProgram(scriptPath)

  const session = createRestartSession(testInfo)
  let app: ElectronApplication | null = null
  try {
    const first = await session.launch()
    app = first.app
    await attachRepoAndOpenTerminal(first.page, repoPath)
    await waitForSessionReady(first.page)
    await ensureTerminalVisible(first.page)
    await waitForActiveTerminalManager(first.page, 30_000)
    const ptyId = await waitForActivePanePtyId(first.page)
    await execInTerminal(first.page, ptyId, `node ${JSON.stringify(scriptPath)}`)
    await expect
      .poll(async () => (await paneGrid(first.page, ptyId))?.content ?? '', { timeout: 20_000 })
      .toContain('IDLE_READY')
    await session.close(first.app)
    app = null

    const second = await session.launch()
    app = second.app
    await waitForSessionReady(second.page)
    await ensureTerminalVisible(second.page)
    await expect
      .poll(() => findRestoredTabForPty(second.page, ptyId), { timeout: 20_000 })
      .not.toBeNull()
    await expect
      .poll(async () => (await paneGrid(second.page, ptyId))?.content ?? '', { timeout: 20_000 })
      .toContain('IDLE_READY')
    await hideBehindNewTab(second.page)
    await expect.poll(async () => (await paneGrid(second.page, ptyId))?.visible).toBe(false)
    const hiddenPane = await paneGrid(second.page, ptyId)

    const offer = await createRuntimeDesktopPairingOffer(second.page)
    const pairing = decodePairingOffer(offer.pairingUrl)
    let handle: string | undefined
    // The new tab's PTY spawn refuses terminal.list until its pane binds.
    await expect
      .poll(
        async () => {
          const list = await sendRemoteRuntimeRequest<{
            terminals: { handle: string; ptyId: string | null }[]
          }>(pairing, 'terminal.list', {}, 15_000)
          if (!list.ok) {
            return JSON.stringify(list)
          }
          handle = list.result.terminals.find((terminal) => terminal.ptyId === ptyId)?.handle
          return handle ? 'listed' : 'relaunched terminal is not listed'
        },
        { timeout: 20_000 }
      )
      .toBe('listed')

    const seen: { snapshot: { cols: number; rows: number } | null } = { snapshot: null }
    const subscription = await subscribeRemoteRuntimeRequest(
      pairing,
      'terminal.subscribe',
      {
        terminal: handle,
        client: { id: 'e2e-phone', type: 'mobile' },
        viewport: PHONE,
        capabilities: { terminalBinaryStream: 1 }
      },
      30_000,
      {
        onResponse: () => {},
        onBinary: (bytes) => {
          const frame = decodeTerminalStreamFrame(bytes)
          if (frame?.opcode === TerminalStreamOpcode.SnapshotStart && !seen.snapshot) {
            seen.snapshot = decodeTerminalStreamJson<{ cols: number; rows: number }>(frame.payload)
          }
        },
        onError: () => {}
      }
    )
    try {
      await expect.poll(() => seen.snapshot, { timeout: 15_000 }).not.toBeNull()
    } finally {
      subscription.close()
    }
    const observed = seen.snapshot
    testInfo.annotations.push({
      type: 'evidence',
      description: JSON.stringify({
        hiddenPane: hiddenPane && { cols: hiddenPane.cols, rows: hiddenPane.rows },
        firstSnapshot: observed && { cols: observed.cols, rows: observed.rows }
      })
    })
    expect(hiddenPane?.cols, 'the hidden pane must stay off the phone grid to reproduce').not.toBe(
      PHONE.cols
    )
    expect(observed && { cols: observed.cols, rows: observed.rows }).toEqual(PHONE)
  } finally {
    if (app) {
      await session.close(app)
    }
    await session.dispose()
  }
})
