import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import type { TerminalLayoutSnapshot } from '../../src/shared/terminal-tab-types'
import { DEFAULT_LOCAL_ORCA_PROFILE_ID } from '../../src/shared/orca-profiles'
import { test, expect } from './helpers/orca-app'
import {
  findMarkerFrame,
  readActiveScreen,
  readRenderedAltScreenFrame,
  type ActiveScreen
} from './helpers/alt-screen-frame'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { stageNodeScriptForTerminal } from './helpers/run-node-script-in-terminal'
import {
  execInTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForPaneCount,
  waitForTerminalOutput
} from './helpers/terminal'
import {
  ensureTerminalVisible,
  getActiveTabId,
  getActiveWorktreeId,
  waitForSessionReady
} from './helpers/store'
import { TEST_REPO_PATH_FILE } from './global-setup'

type PersistedData = {
  workspaceSession?: {
    activeTabId?: string | null
    terminalLayoutsByTabId?: Record<string, TerminalLayoutSnapshot>
  }
}

type RendererOwnershipSnapshot = {
  paneCount: number
  xtermCount: number
  rootLeafCount: number
  ptyBindingCount: number
  uniquePtyCount: number
}

function streamingTuiSource(marker: string): string {
  return `
let frame = 0
process.stdout.write('\\x1b[?1049h\\x1b[?25l')
setInterval(() => {
  frame += 1
  const lines = [${JSON.stringify(marker)} + ' frame ' + String(frame).padStart(6, '0')]
  for (let row = 1; row <= 32; row += 1) {
    const width = 8 + ((frame + row * 7) % 48)
    lines.push(String(row).padStart(2, '0') + ' OpenCode tool output ' + '#'.repeat(width))
  }
  process.stdout.write('\\x1b[?2026h\\x1b[H' + lines.join('\\r\\n') + '\\x1b[J\\x1b[?2026l')
}, 32)
`.trim()
}

function persistedDataPath(userDataDir: string): string {
  return path.join(userDataDir, 'profiles', DEFAULT_LOCAL_ORCA_PROFILE_ID, 'orca-data.json')
}

function seedDuplicatePtyOwnership(userDataDir: string): void {
  const dataPath = persistedDataPath(userDataDir)
  const data = JSON.parse(readFileSync(dataPath, 'utf8')) as PersistedData
  const session = data.workspaceSession
  const tabId = session?.activeTabId
  const layout = tabId ? session?.terminalLayoutsByTabId?.[tabId] : undefined
  const retainedLeafId = layout?.activeLeafId
  const ptyId = retainedLeafId ? layout?.ptyIdsByLeafId?.[retainedLeafId] : undefined
  if (!session?.terminalLayoutsByTabId || !tabId || !layout || !retainedLeafId || !ptyId) {
    throw new Error('Persisted terminal ownership was unavailable for duplicate-layout seeding')
  }

  const duplicateLeafId = randomUUID()
  session.terminalLayoutsByTabId[tabId] = {
    ...layout,
    root: {
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: retainedLeafId },
      second: { type: 'leaf', leafId: duplicateLeafId }
    },
    activeLeafId: retainedLeafId,
    expandedLeafId: null,
    ptyIdsByLeafId: {
      [retainedLeafId]: ptyId,
      [duplicateLeafId]: ptyId
    }
  }
  writeFileSync(dataPath, `${JSON.stringify(data, null, 2)}\n`)
}

async function waitForRestoredTerminal(page: Page, worktreeId: string): Promise<string> {
  await waitForSessionReady(page)
  await expect.poll(() => getActiveWorktreeId(page), { timeout: 15_000 }).toBe(worktreeId)
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page, 30_000)
  await waitForPaneCount(page, 1, 30_000)
  const tabId = await getActiveTabId(page)
  if (!tabId) {
    throw new Error('Restored terminal tab was unavailable')
  }
  return tabId
}

async function readRendererOwnership(
  page: Page,
  tabId: string
): Promise<RendererOwnershipSnapshot> {
  return page.evaluate((tabId) => {
    const layout = window.__store?.getState().terminalLayoutsByTabId[tabId]
    const manager = window.__paneManagers?.get(tabId)
    const surface = document.querySelector(
      `[data-terminal-tab-id="${CSS.escape(tabId)}"][data-terminal-layout-leaf-ids]`
    )
    const countLeaves = (node: TerminalLayoutSnapshot['root']): number =>
      !node ? 0 : node.type === 'leaf' ? 1 : countLeaves(node.first) + countLeaves(node.second)
    const ptyIds = Object.values(layout?.ptyIdsByLeafId ?? {})
    return {
      paneCount: manager?.getPanes?.().length ?? 0,
      xtermCount: surface?.querySelectorAll('.xterm').length ?? 0,
      rootLeafCount: countLeaves(layout?.root ?? null),
      ptyBindingCount: ptyIds.length,
      uniquePtyCount: new Set(ptyIds).size
    }
  }, tabId)
}

// Viewport-only, so it is the same projection the revealed pane is read with.
async function readMainStreamingFrame(
  page: Page,
  ptyId: string,
  marker: string
): Promise<number | null> {
  const content = await page.evaluate(async (ptyId) => {
    const snapshot = await window.api.pty.getMainBufferSnapshot(ptyId, { scrollbackRows: 0 })
    return snapshot?.data ?? null
  }, ptyId)
  return findMarkerFrame(content ?? '', marker)
}

type RevealFrameDiagnostics = {
  bufferType: ActiveScreen['bufferType'] | null
  screenFrame: number | null
  serializedFrame: number | null
  serializedLength: number
  markerOffsets: number[]
  screenRows: string[]
}

// Why: if the revealed pane ever fails to converge, whether the freshest marker is on
// screen, only in normal-buffer scrollback, or absent is what separates a stalled
// renderer from stale residue left by the restore replay (STA-5208).
async function readRevealFrameDiagnostics(
  page: Page,
  tabId: string,
  marker: string
): Promise<RevealFrameDiagnostics> {
  const screen = await readActiveScreen(page, tabId)
  const serialized =
    (await page.evaluate((tabId) => {
      // Same pane resolution as readActiveScreen, so both halves describe one pane.
      const manager = window.__paneManagers?.get(tabId)
      const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0]
      return pane?.serializeAddon?.serialize?.() ?? null
    }, tabId)) ?? ''
  const prefix = `${marker} frame `
  const markerOffsets: number[] = []
  for (let at = serialized.indexOf(prefix); at >= 0; at = serialized.indexOf(prefix, at + 1)) {
    markerOffsets.push(at)
  }
  return {
    bufferType: screen?.bufferType ?? null,
    screenFrame: screen ? findMarkerFrame(screen.rows.join('\n'), marker) : null,
    serializedFrame: findMarkerFrame(serialized, marker),
    serializedLength: serialized.length,
    markerOffsets,
    screenRows: screen?.rows ?? []
  }
}

test('repairs duplicate persisted PTY renderers before streaming tab reveal', async (// oxlint-disable-next-line no-empty-pattern -- this restart test owns its Electron launches.
{}, testInfo) => {
  const repoPath = existsSync(TEST_REPO_PATH_FILE)
    ? readFileSync(TEST_REPO_PATH_FILE, 'utf8').trim()
    : ''
  test.skip(!repoPath || !existsSync(repoPath), 'Seeded E2E repository is unavailable')

  const session = createRestartSession(testInfo)
  const marker = `DUPLICATE_PTY_REVEAL_${randomUUID()}`
  const tui = stageNodeScriptForTerminal(streamingTuiSource(marker))
  let firstApp: ElectronApplication | null = null
  let secondApp: ElectronApplication | null = null

  try {
    const firstLaunch = await session.launch()
    firstApp = firstLaunch.app
    const worktreeId = await attachRepoAndOpenTerminal(firstLaunch.page, repoPath)
    await waitForSessionReady(firstLaunch.page)
    await ensureTerminalVisible(firstLaunch.page)
    await waitForActiveTerminalManager(firstLaunch.page, 30_000)
    const firstPtyId = await waitForActivePanePtyId(firstLaunch.page)
    await execInTerminal(firstLaunch.page, firstPtyId, tui.command)
    await waitForTerminalOutput(firstLaunch.page, marker, 20_000)
    tui.cleanup()

    await session.close(firstApp)
    firstApp = null
    seedDuplicatePtyOwnership(session.userDataDir)

    const secondLaunch = await session.launch()
    secondApp = secondLaunch.app
    const restoredTabId = await waitForRestoredTerminal(secondLaunch.page, worktreeId)
    await waitForTerminalOutput(secondLaunch.page, marker, 20_000)
    const frameBeforeHide = await readMainStreamingFrame(secondLaunch.page, firstPtyId, marker)
    if (frameBeforeHide === null) {
      throw new Error('Authoritative TUI frame was unavailable before hiding the restored tab')
    }

    const siblingTabId = await secondLaunch.page.evaluate((worktreeId) => {
      const store = window.__store
      if (!store) {
        throw new Error('Renderer store unavailable')
      }
      return store.getState().createTab(worktreeId, undefined, undefined, { activate: false }).id
    }, worktreeId)
    await secondLaunch.page.evaluate(
      (tabId) => window.__store?.getState().setActiveTab(tabId),
      siblingTabId
    )
    await expect
      .poll(() => getActiveTabId(secondLaunch.page), { timeout: 10_000 })
      .toBe(siblingTabId)
    const restoredSurface = secondLaunch.page.locator(
      `[data-terminal-tab-id=${JSON.stringify(restoredTabId)}]`
    )
    await expect(restoredSurface).toBeHidden()
    await expect
      .poll(() => readMainStreamingFrame(secondLaunch.page, firstPtyId, marker), {
        timeout: 10_000,
        message: 'Authoritative TUI output did not advance while the restored tab was hidden'
      })
      .toBeGreaterThan(frameBeforeHide)
    const hiddenFrame = await readMainStreamingFrame(secondLaunch.page, firstPtyId, marker)
    if (hiddenFrame === null || hiddenFrame <= frameBeforeHide) {
      throw new Error('Authoritative TUI output did not remain advanced while the tab was hidden')
    }
    await secondLaunch.page.evaluate(
      (tabId) => window.__store?.getState().setActiveTab(tabId),
      restoredTabId
    )
    await expect
      .poll(() => getActiveTabId(secondLaunch.page), { timeout: 10_000 })
      .toBe(restoredTabId)
    // Ownership first: the frame is read off the single repaired pane, so the repair has
    // to have settled before that read means anything.
    await expect
      .poll(() => readRendererOwnership(secondLaunch.page, restoredTabId), { timeout: 10_000 })
      .toEqual({
        paneCount: 1,
        xtermCount: 1,
        rootLeafCount: 1,
        ptyBindingCount: 1,
        uniquePtyCount: 1
      })
    let revealFailure: unknown = null
    try {
      await expect
        .poll(() => readRenderedAltScreenFrame(secondLaunch.page, restoredTabId, marker), {
          timeout: 20_000,
          message: 'Revealed renderer did not catch up to hidden authoritative output'
        })
        .toBeGreaterThanOrEqual(hiddenFrame)
      // The fixture enters the alternate buffer once at startup and repaints in place, so a
      // revealed pane parked on the normal buffer is painting the TUI into scrollback.
      const revealedScreen = await readActiveScreen(secondLaunch.page, restoredTabId)
      expect(
        revealedScreen?.bufferType,
        'revealed pane was missing or painting outside the alternate buffer'
      ).toBe('alternate')
    } catch (error) {
      // Diagnostics are more page reads, so a dead page has to degrade to a note in the
      // attachment rather than replacing the failure the attachment exists to explain.
      revealFailure = error
      const diagnostics = await readRevealFrameDiagnostics(
        secondLaunch.page,
        restoredTabId,
        marker
      ).catch((diagnosticsError: unknown) => ({ diagnosticsError: String(diagnosticsError) }))
      await testInfo.attach('duplicate-pty-reveal-frame-diagnostics.json', {
        body: JSON.stringify(diagnostics, null, 2),
        contentType: 'application/json'
      })
    }
    // Evidence for both outcomes; a capture that fails must not become the verdict.
    const screenshot = await secondLaunch.page.screenshot().catch(() => null)
    if (screenshot) {
      await testInfo.attach('duplicate-pty-renderer-after-reveal.png', {
        body: screenshot,
        contentType: 'image/png'
      })
    }
    if (revealFailure) {
      throw revealFailure
    }
  } finally {
    tui.cleanup()
    if (secondApp) {
      await session.close(secondApp)
    }
    if (firstApp) {
      await session.close(firstApp)
    }
    await session.dispose()
  }
})
