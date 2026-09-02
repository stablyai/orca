import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { TEST_REPO_PATH_FILE } from './global-setup'
import {
  execInTerminal,
  splitActiveTerminalPane,
  waitForActiveTerminalManager,
  waitForPaneCount,
  waitForPaneIdentitySnapshot
} from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { PTY_SESSION_ID_SEPARATOR } from '../../src/shared/pty-session-id-format'

type PaneProbe = {
  content: string
  cols: number
  rows: number
  proposed: { cols: number; rows: number } | null
  rect: { width: number; height: number }
}

function frameNumber(content: string): number {
  const matches = [...content.matchAll(/REATTACH_FRAME_(\d+)/g)]
  return Number(matches.at(-1)?.[1] ?? 0)
}

function heartbeatNumber(path: string): number {
  return Number(readFileSync(path, 'utf8').trim())
}

function writeStreamingTui(scriptPath: string): void {
  mkdirSync(path.dirname(scriptPath), { recursive: true })
  writeFileSync(
    scriptPath,
    [
      "import { writeFileSync } from 'node:fs'",
      'const heartbeatPath = process.argv[2]',
      'let frame = 0',
      "process.stdout.write('\\x1b[?1049h\\x1b[?25l')",
      'setInterval(() => {',
      '  frame += 1',
      '  writeFileSync(heartbeatPath, String(frame))',
      '  const body = [',
      "    '╭────────────────────────────────────────────────────╮',",
      "    `│ Orca warm reattach frame ${String(frame).padStart(6, '0')} 🟢 │`,",
      "    '├────────────────────────────────────────────────────┤',",
      '    `│ REATTACH_FRAME_${frame} live daemon output             │`,',
      "    '╰────────────────────────────────────────────────────╯'",
      "  ].join('\\r\\n')",
      '  process.stdout.write(`\\x1b[?2026h\\x1b[2J\\x1b[H${body}\\x1b[?2026l`)',
      '}, 50)',
      ''
    ].join('\n')
  )
}

async function setFullscreen(app: ElectronApplication, page: Page): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    if (!window) {
      throw new Error('No Electron window')
    }
    window.show()
    window.setFullScreen(true)
  })
  await expect
    .poll(
      async () => ({
        fullscreen: await app.evaluate(
          ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isFullScreen() ?? false
        ),
        size: await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
      }),
      { timeout: 15_000 }
    )
    .toMatchObject({
      fullscreen: true,
      size: { width: expect.any(Number), height: expect.any(Number) }
    })
  await page.waitForTimeout(1_200)
}

async function createActiveDecoyTab(page: Page, worktreeId: string): Promise<void> {
  await page.evaluate((worktreeId) => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    const state = store.getState()
    const tab = state.createTab(worktreeId, undefined, undefined, { activate: true })
    state.setActiveTab(tab.id)
    state.setActiveTabType('terminal')
  }, worktreeId)
  await waitForActiveTerminalManager(page, 30_000)
  await waitForPaneCount(page, 1, 30_000)
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

async function activateTabWithoutFocus(page: Page, tabId: string): Promise<void> {
  await page.evaluate((tabId) => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    store.getState().setActiveTabType('terminal')
    store.getState().setActiveTab(tabId)
  }, tabId)
}

async function probePane(page: Page, tabId: string, ptyId: string): Promise<PaneProbe | null> {
  return page.evaluate(
    ({ tabId, ptyId }) => {
      const pane = window.__paneManagers
        ?.get(tabId)
        ?.getPanes?.()
        .find((candidate) => candidate.container.dataset.ptyId === ptyId)
      if (!pane) {
        return null
      }
      let proposed: { cols: number; rows: number } | null = null
      try {
        proposed = pane.fitAddon.proposeDimensions() ?? null
      } catch {
        proposed = null
      }
      const rect = pane.container.getBoundingClientRect()
      return {
        content: pane.serializeAddon.serialize(),
        cols: pane.terminal.cols,
        rows: pane.terminal.rows,
        proposed,
        rect: { width: rect.width, height: rect.height }
      }
    },
    { tabId, ptyId }
  )
}

test.describe.configure({ mode: 'serial' })

test('restored hidden split drains live alternate-screen output without a click @headful', async (// oxlint-disable-next-line no-empty-pattern -- This restart test owns both app launches.
{}, testInfo) => {
  test.setTimeout(300_000)
  test.skip(process.platform === 'win32', 'The streaming fixture uses a POSIX shell command')
  const repoPath = readFileSync(TEST_REPO_PATH_FILE, 'utf8').trim()
  test.skip(!repoPath || !existsSync(repoPath), 'Global setup did not produce a seeded test repo')

  const scriptPath = testInfo.outputPath('streaming-tui.mjs')
  const heartbeatPath = testInfo.outputPath('streaming-tui-heartbeat.txt')
  writeStreamingTui(scriptPath)

  const session = createRestartSession(testInfo)
  let firstApp: ElectronApplication | null = null
  let secondApp: ElectronApplication | null = null
  try {
    const first = await session.launch()
    firstApp = first.app
    await setFullscreen(first.app, first.page)
    const worktreeId = await attachRepoAndOpenTerminal(first.page, repoPath)
    await waitForSessionReady(first.page)
    await waitForActiveWorktree(first.page)
    await ensureTerminalVisible(first.page)
    await waitForActiveTerminalManager(first.page, 30_000)
    await waitForPaneCount(first.page, 1, 30_000)

    await splitActiveTerminalPane(first.page, 'horizontal')
    await waitForPaneCount(first.page, 2, 30_000)
    const split = await waitForPaneIdentitySnapshot(first.page, 2)
    const streamingPane = split.panes.find((pane) => pane.leafId === split.activeLeafId)
    if (!streamingPane?.ptyId) {
      throw new Error('Split did not expose its active PTY')
    }
    expect(streamingPane.ptyId).toContain(PTY_SESSION_ID_SEPARATOR)
    await execInTerminal(
      first.page,
      streamingPane.ptyId,
      `node ${JSON.stringify(scriptPath)} ${JSON.stringify(heartbeatPath)}`
    )
    await expect
      .poll(
        async () =>
          frameNumber(
            (await probePane(first.page, split.tabId, streamingPane.ptyId))?.content ?? ''
          ),
        {
          timeout: 20_000,
          message: 'Streaming TUI did not start in the split pane'
        }
      )
      .toBeGreaterThan(5)

    // Hide the split tab before quit so relaunch restores the same cold-view boundary as the field incident.
    await createActiveDecoyTab(first.page, worktreeId)
    await first.page.waitForTimeout(1_000)
    const beforeCloseHeartbeat = heartbeatNumber(heartbeatPath)
    await session.close(firstApp)
    firstApp = null
    await new Promise((resolve) => setTimeout(resolve, 750))
    expect(heartbeatNumber(heartbeatPath)).toBeGreaterThan(beforeCloseHeartbeat)

    const second = await session.launch()
    secondApp = second.app
    await waitForSessionReady(second.page)
    await waitForActiveWorktree(second.page)
    await ensureTerminalVisible(second.page)

    let restoredTabId: string | null = null
    await expect
      .poll(
        async () => {
          restoredTabId = await findRestoredTabForPty(second.page, streamingPane.ptyId!)
          return restoredTabId
        },
        { timeout: 20_000, message: 'Persisted split PTY was not restored into a tab layout' }
      )
      .not.toBeNull()
    await activateTabWithoutFocus(second.page, restoredTabId!)
    await waitForActiveTerminalManager(second.page, 30_000)
    await waitForPaneCount(second.page, 2, 30_000)

    const initial = await probePane(second.page, restoredTabId!, streamingPane.ptyId)
    expect(initial, 'Streaming pane did not remount after tab activation').not.toBeNull()
    const initialFrame = frameNumber(initial!.content)
    const initialHeartbeat = heartbeatNumber(heartbeatPath)
    await second.page.waitForTimeout(2_000)
    const later = await probePane(second.page, restoredTabId!, streamingPane.ptyId)
    const laterHeartbeat = heartbeatNumber(heartbeatPath)

    expect(
      laterHeartbeat,
      'Fixture process stopped instead of exercising live output'
    ).toBeGreaterThan(initialHeartbeat + 20)
    expect(later?.rect.width ?? 0).toBeGreaterThan(0)
    expect(later?.rect.height ?? 0).toBeGreaterThan(0)
    expect(later?.proposed).toEqual({ cols: later?.cols, rows: later?.rows })
    expect(
      frameNumber(later?.content ?? ''),
      `Renderer frame did not advance while daemon heartbeat moved ${initialHeartbeat} -> ${laterHeartbeat}; initial=${JSON.stringify(initial)} later=${JSON.stringify(later)}`
    ).toBeGreaterThan(initialFrame + 20)
  } finally {
    if (secondApp) {
      await session.close(secondApp)
    }
    if (firstApp) {
      await session.close(firstApp)
    }
    await session.dispose()
  }
})
