import { mkdirSync, writeFileSync } from 'node:fs'
import { realpathSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication, Page, TestInfo } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { removeWorktreeViaStore } from './helpers/dead-terminal'
import {
  ensureTerminalVisible,
  getActiveWorktreeId,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import {
  sendToTerminal,
  waitForActiveTerminalManager,
  waitForPaneCount,
  waitForPaneIdentitySnapshot
} from './helpers/terminal'
import { compareTerminalScreenshots } from './terminal-screenshot-diff'

const RUN_REPRO = process.env.ORCA_E2E_CODEX_SKILL_PREVIEW_REPRO === '1'
const EXPECT_NO_ARTIFACTS = process.env.ORCA_E2E_EXPECT_NO_CODEX_SKILL_PREVIEW_ARTIFACTS === '1'
const FULLSCREEN_MIN_SIZE = { width: 1200, height: 760 }
const MIN_REPRO_DIFF_RATIO = 0.006
const MAX_CLEAN_DIFF_RATIO = 0.0015
const ORCA_REPO_PATH = realpathSync(process.cwd())
const ARTIFACT_DIR = path.join(process.cwd(), '.tmp', 'codex-skill-preview-real-flow')

const CODEX_READY_RE = /Ask Codex|OpenAI Codex/i
const CODEX_TRUST_PROMPT_RE =
  /Do you trust|trust this folder|Trust this|Working with untrusted contents/i
const CODEX_UPDATE_PROMPT_RE = /update available|install update|Skip for now|Skip until next/i
const CODEX_SKILL_PREVIEW_RE = /Press enter to insert|esc to close|electron|orca-cli|orca-emulator/i
const SETUP_PANE_ACTIVITY_RE = /install-orca-skills|pnpm|Progress:|Packages:|Lockfile/i
const CLEAN_SKILL_ROW_RE = /^  [A-Za-z][A-Za-z0-9 .-]{1,32}\s+\[Skill\]\s/
const CODEX_READY_SETTLE_MS = 3_500
const SETUP_CHANGES_AFTER_PREVIEW = 3

type PaneDescriptor = {
  tabId: string
  paneId: number
  leafId: string
  ptyId: string
  rect: { x: number; y: number; width: number; height: number }
  cols: number
  rows: number
  proposed: { cols: number; rows: number } | null
  appliedPtySize: { cols: number; rows: number } | null
  viewportY: number
  baseY: number
  isUserScrolling: boolean | null
  screenToPaneGap: number | null
  hasWebgl: boolean
}

type ArtifactCapture = {
  diffRatio: number
  changedPixels: number
  totalPixels: number
  leftPane: PaneDescriptor
  beforeContent: string
  afterContent: string
}

async function setStableFullscreenWindow(
  electronApp: ElectronApplication,
  page: Page
): Promise<void> {
  await electronApp.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    if (!window) {
      throw new Error('No BrowserWindow available')
    }
    if (window.isMinimized()) {
      window.restore()
    }
    window.show()
    window.focus()
    window.setFullScreen(true)
  })
  await expect
    .poll(
      async () => {
        const [fullscreen, size] = await Promise.all([
          electronApp.evaluate(({ BrowserWindow }) => {
            const window = BrowserWindow.getAllWindows()[0]
            return window?.isFullScreen() ?? false
          }),
          page.evaluate(() => ({
            width: window.innerWidth,
            height: window.innerHeight
          }))
        ])
        return (
          fullscreen &&
          size.width >= FULLSCREEN_MIN_SIZE.width &&
          size.height >= FULLSCREEN_MIN_SIZE.height
        )
      },
      {
        timeout: 15_000,
        message: 'Electron window did not enter fullscreen for the repro'
      }
    )
    .toBe(true)
  await page.waitForTimeout(1_200)
}

async function addRealOrcaRepo(page: Page, repoPath: string): Promise<string> {
  return page.evaluate(async (repoPath) => {
    await window.api.repos.add({ path: repoPath }).catch((error: unknown) => {
      if (!/already|exists|duplicate/i.test(String(error))) {
        throw error
      }
    })

    const store = window.__store
    if (!store) {
      throw new Error('window.__store unavailable')
    }
    const state = store.getState()
    await state.fetchRepos()
    const repo = store.getState().repos.find((candidate) => candidate.path === repoPath)
    if (!repo) {
      throw new Error(`Real Orca repo did not load: ${repoPath}`)
    }

    await store.getState().updateRepo(repo.id, {
      externalWorktreeVisibility: 'show',
      hookSettings: {
        ...repo.hookSettings,
        setupRunPolicy: 'run-by-default',
        setupAgentStartupPolicy: 'start-immediately'
      }
    })
    await store.getState().fetchWorktrees(repo.id)

    const nextState = store.getState()
    const worktree = (nextState.worktreesByRepo[repo.id] ?? []).find(
      (candidate) => candidate.path === repoPath
    )
    if (!worktree) {
      throw new Error(`Real Orca worktree did not load: ${repoPath}`)
    }

    nextState.updateSettings({
      defaultTuiAgent: 'codex',
      disabledTuiAgents: [],
      setupScriptLaunchMode: 'split-vertical',
      terminalGpuAcceleration: 'on',
      theme: 'dark'
    })
    nextState.setActiveRepo(repo.id)
    nextState.setActiveView('terminal')
    nextState.setActiveWorktree(worktree.id)
    nextState.setRightSidebarOpen(false)
    nextState.setSidebarOpen(true)
    return repo.id
  }, repoPath)
}

async function createWorkspaceThroughComposer(page: Page, workspaceName: string): Promise<string> {
  const previousWorktreeId = await getActiveWorktreeId(page)
  await page.getByRole('button', { name: 'New workspace', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: /Create (Workspace|Worktree)/i })
  await expect(dialog).toBeVisible({ timeout: 10_000 })
  await expect(dialog.locator('[data-workspace-name-input="true"]')).toBeVisible({
    timeout: 10_000
  })

  const agentCombobox = dialog.locator('[data-agent-combobox-root="true"][role="combobox"]').first()
  await expect(agentCombobox).toContainText(/Codex/i, { timeout: 10_000 })

  const nameInput = dialog.getByPlaceholder(/Type a name/i)
  await nameInput.fill(workspaceName)

  const createButton = dialog.getByRole('button', { name: /Create (Workspace|Worktree)/i })
  await expect(createButton).toBeEnabled({ timeout: 10_000 })
  await createButton.click()

  await page
    .getByRole('button', { name: 'Run hooks' })
    .click({ timeout: 5_000 })
    .catch(() => undefined)

  await expect(dialog).toBeHidden({ timeout: 60_000 })
  await expect
    .poll(
      async () =>
        page.evaluate((workspaceName) => {
          const state = window.__store?.getState()
          const worktree = Object.values(state?.worktreesByRepo ?? {})
            .flat()
            .find(
              (candidate) =>
                candidate.displayName === workspaceName || candidate.path.endsWith(workspaceName)
            )
          return worktree?.id ?? null
        }, workspaceName),
      {
        timeout: 60_000,
        message: `Workspace ${workspaceName} did not appear in the real Orca repo`
      }
    )
    .not.toBeNull()

  const createdId = await page.evaluate((workspaceName) => {
    const state = window.__store?.getState()
    const worktree = Object.values(state?.worktreesByRepo ?? {})
      .flat()
      .find(
        (candidate) =>
          candidate.displayName === workspaceName || candidate.path.endsWith(workspaceName)
      )
    return worktree?.id ?? null
  }, workspaceName)
  if (!createdId) {
    throw new Error(`Workspace ${workspaceName} disappeared after creation`)
  }
  await expect
    .poll(() => getActiveWorktreeId(page), {
      timeout: 30_000,
      message: 'Created real Orca workspace did not become active'
    })
    .toBe(createdId)
  expect(createdId).not.toBe(previousWorktreeId)
  return createdId
}

async function forceTerminalWebgl(page: Page): Promise<boolean> {
  await page.evaluate(() => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    const tabId =
      state?.activeTabType === 'terminal'
        ? state.activeTabId
        : worktreeId
          ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
          : null
    if (!tabId) {
      throw new Error('No active terminal tab')
    }
    window.__paneManagers?.get(tabId)?.setTerminalGpuAcceleration?.('on')
  })

  return page
    .waitForFunction(
      () => {
        const state = window.__store?.getState()
        const worktreeId = state?.activeWorktreeId
        const tabId =
          state?.activeTabType === 'terminal'
            ? state.activeTabId
            : worktreeId
              ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
              : null
        const diagnostics = window.__paneManagers?.get(tabId ?? '')?.getRenderingDiagnostics?.()
        return (diagnostics ?? []).filter((diagnostic) => diagnostic.hasWebgl).length >= 2
      },
      undefined,
      { timeout: 10_000 }
    )
    .then(() => true)
    .catch(() => false)
}

async function describeActiveTerminalPanes(page: Page): Promise<PaneDescriptor[]> {
  return page.evaluate(async () => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    const tabId =
      state?.activeTabType === 'terminal'
        ? state.activeTabId
        : worktreeId
          ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
          : null
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    const panes = manager?.getPanes?.() ?? []
    if (!tabId || !manager || panes.length < 2) {
      throw new Error('Expected a split terminal tab with at least two panes')
    }
    const diagnostics = manager.getRenderingDiagnostics?.() ?? []
    return Promise.all(
      [...panes]
        .sort((a, b) => {
          const aRect = a.container.getBoundingClientRect()
          const bRect = b.container.getBoundingClientRect()
          return aRect.x - bRect.x || aRect.y - bRect.y
        })
        .map(async (pane) => {
          const ptyId = pane.container.dataset.ptyId
          if (!ptyId) {
            throw new Error(`Terminal pane ${pane.id} has no PTY binding`)
          }
          const rect = pane.container.getBoundingClientRect()
          const screenRect = pane.container
            .querySelector<HTMLElement>('.xterm-screen')
            ?.getBoundingClientRect()
          const rendering = diagnostics.find((diagnostic) => diagnostic.paneId === pane.id)
          let proposed: { cols: number; rows: number } | null = null
          try {
            proposed = pane.fitAddon.proposeDimensions() ?? null
          } catch {
            proposed = null
          }
          const appliedPtySize = await window.api.pty.getSize(ptyId).catch(() => null)
          const terminalCore = pane.terminal as typeof pane.terminal & {
            _core?: { _bufferService?: { isUserScrolling?: boolean } }
          }
          return {
            tabId,
            paneId: pane.id,
            leafId: pane.leafId,
            ptyId,
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            cols: pane.terminal.cols,
            rows: pane.terminal.rows,
            proposed,
            appliedPtySize,
            viewportY: pane.terminal.buffer.active.viewportY,
            baseY: pane.terminal.buffer.active.baseY,
            isUserScrolling:
              typeof terminalCore._core?._bufferService?.isUserScrolling === 'boolean'
                ? terminalCore._core._bufferService.isUserScrolling
                : null,
            screenToPaneGap: screenRect ? rect.right - screenRect.right : null,
            hasWebgl: rendering?.hasWebgl ?? false
          }
        })
    )
  })
}

async function focusTerminalPane(page: Page, pane: PaneDescriptor): Promise<void> {
  await page.evaluate(({ tabId, ptyId }) => {
    const manager = window.__paneManagers?.get(tabId)
    const pane = manager
      ?.getPanes?.()
      .find((candidate) => candidate.container.dataset.ptyId === ptyId)
    if (!pane) {
      throw new Error('Terminal pane disappeared before focus')
    }
    manager?.setActivePane(pane.id, { focus: true })
    pane.terminal.options.cursorBlink = false
    pane.terminal.options.cursorStyle = 'block'
    pane.terminal.focus()
    pane.container.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')?.focus()
  }, pane)
}

async function focusLeftTerminalPane(page: Page): Promise<PaneDescriptor> {
  const [leftPane] = await describeActiveTerminalPanes(page)
  if (!leftPane) {
    throw new Error('Left terminal pane is unavailable')
  }
  await focusTerminalPane(page, leftPane)
  return leftPane
}

async function getRightTerminalPane(page: Page): Promise<PaneDescriptor> {
  const panes = await describeActiveTerminalPanes(page)
  const rightPane = panes.at(-1)
  if (!rightPane) {
    throw new Error('Right setup terminal pane is unavailable')
  }
  return rightPane
}

async function readPaneContent(
  page: Page,
  tabId: string,
  ptyId: string,
  charLimit = 8_000
): Promise<string> {
  return page.evaluate(
    ({ tabId, ptyId, charLimit }) => {
      const manager = window.__paneManagers?.get(tabId)
      const pane = manager
        ?.getPanes?.()
        .find((candidate) => candidate.container.dataset.ptyId === ptyId)
      const content = pane?.serializeAddon?.serialize?.() ?? ''
      return content.slice(-charLimit)
    },
    { tabId, ptyId, charLimit }
  )
}

async function readPaneVisibleContent(page: Page, tabId: string, ptyId: string): Promise<string> {
  return page.evaluate(
    ({ tabId, ptyId }) => {
      const manager = window.__paneManagers?.get(tabId)
      const pane = manager
        ?.getPanes?.()
        .find((candidate) => candidate.container.dataset.ptyId === ptyId)
      if (!pane) {
        return ''
      }
      const terminal = pane.terminal
      const viewportY = terminal.buffer.active.viewportY
      const lines: string[] = []
      for (let row = 0; row < terminal.rows; row += 1) {
        lines.push(terminal.buffer.active.getLine(viewportY + row)?.translateToString(true) ?? '')
      }
      return lines.join('\n')
    },
    { tabId, ptyId }
  )
}

async function readPaneObservableContent(
  page: Page,
  tabId: string,
  ptyId: string
): Promise<string> {
  const [serialized, visible] = await Promise.all([
    readPaneContent(page, tabId, ptyId, 12_000),
    readPaneVisibleContent(page, tabId, ptyId)
  ])
  return `${serialized}\n${visible}`
}

async function waitForPaneContent(
  page: Page,
  tabId: string,
  ptyId: string,
  pattern: RegExp,
  timeoutMs: number
): Promise<void> {
  await expect
    .poll(async () => pattern.test(await readPaneObservableContent(page, tabId, ptyId)), {
      timeout: timeoutMs,
      message: `Terminal pane did not match ${pattern}`
    })
    .toBe(true)
}

async function waitForPaneVisibleContentChanges(
  page: Page,
  pane: PaneDescriptor,
  expectedChanges: number,
  timeoutMs: number
): Promise<number> {
  const deadline = Date.now() + timeoutMs
  let changes = 0
  let previous = await readPaneVisibleContent(page, pane.tabId, pane.ptyId)
  while (Date.now() < deadline && changes < expectedChanges) {
    await page.waitForTimeout(450)
    const next = await readPaneVisibleContent(page, pane.tabId, pane.ptyId)
    if (next !== previous) {
      changes += 1
      previous = next
    }
  }
  return changes
}

async function dismissCodexPromptsIfPresent(page: Page, pane: PaneDescriptor): Promise<void> {
  const deadline = Date.now() + 25_000
  while (Date.now() < deadline) {
    const content = await readPaneObservableContent(page, pane.tabId, pane.ptyId)
    if (CODEX_READY_RE.test(content) && !CODEX_TRUST_PROMPT_RE.test(content)) {
      return
    }
    if (CODEX_TRUST_PROMPT_RE.test(content)) {
      await sendToTerminal(page, pane.ptyId, '1\r')
      await page.waitForTimeout(400)
      continue
    }
    if (CODEX_UPDATE_PROMPT_RE.test(content)) {
      await sendToTerminal(page, pane.ptyId, '3\r')
      await page.waitForTimeout(400)
      continue
    }
    await page.waitForTimeout(250)
  }
}

async function clickPaneAfterEvidenceCapture(page: Page, pane: PaneDescriptor): Promise<void> {
  await page.mouse.click(
    pane.rect.x + Math.min(120, Math.max(24, pane.rect.width / 2)),
    pane.rect.y + Math.min(80, Math.max(24, pane.rect.height / 4))
  )
}

async function screenshotPane(page: Page, ptyId: string): Promise<Buffer> {
  const screen = page.locator(`[data-pty-id="${ptyId}"] .xterm-screen`).first()
  await expect(screen).toBeVisible({ timeout: 10_000 })
  return Buffer.from(await screen.screenshot({ animations: 'disabled' }))
}

function persistEvidenceFile(name: string, body: Buffer | string): string {
  mkdirSync(ARTIFACT_DIR, { recursive: true })
  const filePath = path.join(ARTIFACT_DIR, name)
  writeFileSync(filePath, body)
  return filePath
}

function getOverpaintedSkillRows(content: string): string[] {
  return content
    .split('\n')
    .filter((line) => line.includes('[Skill]'))
    .filter((line) => !CLEAN_SKILL_ROW_RE.test(line))
}

async function captureClickEvidence(
  page: Page,
  pane: PaneDescriptor,
  testInfo: TestInfo
): Promise<ArtifactCapture> {
  await page.waitForTimeout(250)
  const beforeContent = await readPaneVisibleContent(page, pane.tabId, pane.ptyId)
  const beforeFullPage = Buffer.from(await page.screenshot({ fullPage: true }))
  const beforePane = await screenshotPane(page, pane.ptyId)
  await clickPaneAfterEvidenceCapture(page, pane)
  await page.waitForTimeout(250)
  const afterContent = await readPaneVisibleContent(page, pane.tabId, pane.ptyId)
  const afterPane = await screenshotPane(page, pane.ptyId)
  const diff = compareTerminalScreenshots(beforePane, afterPane)

  const beforePanePath = persistEvidenceFile('left-pane-before-click.png', beforePane)
  const beforeWindowPath = persistEvidenceFile('full-window-before-click.png', beforeFullPage)
  const afterPanePath = persistEvidenceFile('left-pane-after-click.png', afterPane)
  const bufferPath = persistEvidenceFile('left-pane-buffer.txt', beforeContent)
  const metricsPath = persistEvidenceFile(
    'left-pane-metrics.json',
    `${JSON.stringify(pane, null, 2)}\n`
  )

  await testInfo.attach('codex-skill-preview-left-pane-before-click', {
    body: beforePane,
    contentType: 'image/png'
  })
  await testInfo.attach('codex-skill-preview-full-window-before-click', {
    body: beforeFullPage,
    contentType: 'image/png'
  })
  await testInfo.attach('codex-skill-preview-left-pane-after-click', {
    body: afterPane,
    contentType: 'image/png'
  })
  await testInfo.attach('codex-skill-preview-left-pane-buffer.txt', {
    body: beforeContent,
    contentType: 'text/plain'
  })
  testInfo.annotations.push({
    type: 'codex-skill-preview-evidence-files',
    description: JSON.stringify({
      beforePanePath,
      beforeWindowPath,
      afterPanePath,
      bufferPath,
      metricsPath
    })
  })

  return {
    ...diff,
    leftPane: pane,
    beforeContent,
    afterContent
  }
}

test.describe('Codex skill preview terminal artifact repro @headful', () => {
  test.use({ seedTestRepo: false })

  const createdWorktreeIds: string[] = []

  test.skip(!RUN_REPRO, 'Set ORCA_E2E_CODEX_SKILL_PREVIEW_REPRO=1 to run this repro.')

  test.afterEach(async ({ orcaPage }) => {
    for (const id of createdWorktreeIds) {
      await removeWorktreeViaStore(orcaPage, id)
    }
    createdWorktreeIds.length = 0
  })

  test('captures the real Orca repo setup-split Codex skill preview overpaint before any click', async ({
    electronApp,
    orcaPage
  }, testInfo) => {
    test.setTimeout(240_000)
    test.skip(process.platform === 'win32', 'Codex skill preview repro uses POSIX shell commands')

    await setStableFullscreenWindow(electronApp, orcaPage)
    await waitForSessionReady(orcaPage)
    await addRealOrcaRepo(orcaPage, ORCA_REPO_PATH)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)

    const workspaceName = `codex-skill-preview-${Date.now()}`
    const worktreeId = await createWorkspaceThroughComposer(orcaPage, workspaceName)
    createdWorktreeIds.push(worktreeId)

    await ensureTerminalVisible(orcaPage, 30_000)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    await waitForPaneCount(orcaPage, 2, 60_000)
    await waitForPaneIdentitySnapshot(orcaPage, 2)
    const webglActive = await forceTerminalWebgl(orcaPage)
    test.skip(!webglActive, 'Codex skill preview artifact repro needs WebGL rendering')

    const leftPane = await focusLeftTerminalPane(orcaPage)
    const rightPane = await getRightTerminalPane(orcaPage)
    expect(leftPane.hasWebgl).toBe(true)
    expect(rightPane.hasWebgl).toBe(true)
    expect(leftPane.proposed).toEqual({ cols: leftPane.cols, rows: leftPane.rows })
    expect(leftPane.appliedPtySize).toEqual({ cols: leftPane.cols, rows: leftPane.rows })
    expect(leftPane.isUserScrolling).toBe(false)
    await waitForPaneContent(
      orcaPage,
      rightPane.tabId,
      rightPane.ptyId,
      SETUP_PANE_ACTIVITY_RE,
      60_000
    )
    await dismissCodexPromptsIfPresent(orcaPage, leftPane)
    await waitForPaneContent(orcaPage, leftPane.tabId, leftPane.ptyId, CODEX_READY_RE, 60_000)
    await waitForPaneContent(
      orcaPage,
      leftPane.tabId,
      leftPane.ptyId,
      /usage limit reset|YOLO mode|permissions/i,
      15_000
    )
    await orcaPage.waitForTimeout(CODEX_READY_SETTLE_MS)
    await waitForPaneVisibleContentChanges(orcaPage, rightPane, 1, 8_000)

    await focusLeftTerminalPane(orcaPage)
    await orcaPage.keyboard.type('test $e', { delay: 70 })
    await waitForPaneContent(
      orcaPage,
      leftPane.tabId,
      leftPane.ptyId,
      CODEX_SKILL_PREVIEW_RE,
      30_000
    )
    const setupChangesAfterPreview = await waitForPaneVisibleContentChanges(
      orcaPage,
      rightPane,
      SETUP_CHANGES_AFTER_PREVIEW,
      12_000
    )

    const evidence = await captureClickEvidence(orcaPage, leftPane, testInfo)
    const overpaintedSkillRows = getOverpaintedSkillRows(evidence.beforeContent)
    const detectedArtifact =
      overpaintedSkillRows.length >= 2 || evidence.diffRatio >= MIN_REPRO_DIFF_RATIO
    testInfo.annotations.push({
      type: 'codex-skill-preview-click-diff',
      description: JSON.stringify({
        diffRatio: evidence.diffRatio,
        changedPixels: evidence.changedPixels,
        totalPixels: evidence.totalPixels,
        leftPane: evidence.leftPane,
        setupChangesAfterPreview,
        overpaintedSkillRows,
        repoPath: ORCA_REPO_PATH
      })
    })

    if (EXPECT_NO_ARTIFACTS) {
      expect(overpaintedSkillRows).toHaveLength(0)
      expect(evidence.diffRatio).toBeLessThanOrEqual(MAX_CLEAN_DIFF_RATIO)
    } else {
      expect(detectedArtifact).toBe(true)
    }
  })
})
