import type { Locator, Page } from '@stablyai/playwright-test'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { worktreeRow } from './worktree-row-locators'

const CAPTURE_EVIDENCE = process.env.ORCA_CAPTURE_EVIDENCE === '1'
const EVIDENCE_DIR = join(tmpdir(), 'orca-opencode-agent-status-evidence')
const TAB_TITLE = 'Status evidence'
const OPENCODE_RUNTIME_TITLE = 'OC | Status evidence'

type Theme = 'light' | 'dark'
type SeedState = 'working' | 'waiting' | 'blocked' | 'done'

type AgentStatusSeed = {
  state: SeedState
  prompt: string
  agentType?: 'codex' | 'opencode'
  toolName?: string
  toolInput?: string
  interactivePrompt?: string
  lastAssistantMessage?: string
  interrupted?: boolean
}

type StateExpectation = {
  evidenceName: string
  tabStatus: string
  tabLabel: string
  cardLabel: string
  rowLabel: string
  tabStyle: string
  cardStyle?: string
  toolText?: string
}

type LeadingGeometry = {
  laneWidth: number
  titleOffset: number
}

type WorktreeLivenessSnapshot = Record<string, string[] | undefined>

function terminalTab(page: Page, tabId: string): Locator {
  return page.locator(`[data-testid="sortable-tab"][data-tab-id=${JSON.stringify(tabId)}]`)
}

function statusSlot(page: Page, worktreeId: string): Locator {
  return worktreeRow(page, worktreeId).locator('[data-worktree-card-status-slot]')
}

function agentGroup(page: Page, worktreeId: string): Locator {
  return worktreeRow(page, worktreeId).getByRole('group', { name: 'Agents' })
}

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1
}

function countSnapshotImagesNamed(snapshot: string, label: string): number {
  const prefix = `- img ${JSON.stringify(label)}`
  return snapshot.split('\n').filter((line) => line.trimStart().startsWith(prefix)).length
}

async function setTheme(page: Page, theme: Theme): Promise<void> {
  await page.evaluate(async (nextTheme) => {
    const settings = await window.api.settings.set({ theme: nextTheme })
    window.__store?.setState({ settings })
  }, theme)
  await expect
    .poll(() => page.evaluate(() => document.documentElement.classList.contains('dark')))
    .toBe(theme === 'dark')
}

async function configureStatusEvidence(
  page: Page,
  worktreeId: string
): Promise<{ tabId: string; paneKeys: string[] }> {
  return page.evaluate(
    ({ targetWorktreeId, runtimeTitle, tabTitle }) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      const state = store.getState()
      const cardProperties = new Set(state.worktreeCardProperties)
      cardProperties.add('status')
      cardProperties.add('inline-agents')
      state.setWorktreeCardProperties([...cardProperties])
      state.setAgentActivityDisplayMode('full')
      // Why: launchAgent is durable pane ownership; the native `OC |` title is
      // corroborating runtime evidence, not the sole provider heuristic. Keep
      // this evidence tab in the background so a real shell cannot rewrite its
      // synthetic title while the spec exercises quiet identity.
      const tab = state.createTab(targetWorktreeId, undefined, undefined, {
        activate: false,
        launchAgent: 'opencode'
      })
      state.updateTabTitle(tab.id, runtimeTitle)
      state.setTabCustomTitle(tab.id, tabTitle)

      return {
        tabId: tab.id,
        paneKeys: [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()].map(
          (leafId) => `${tab.id}:${leafId}`
        )
      }
    },
    {
      targetWorktreeId: worktreeId,
      runtimeTitle: OPENCODE_RUNTIME_TITLE,
      tabTitle: TAB_TITLE
    }
  )
}

async function clearSeededState(page: Page, tabId: string, paneKeys: string[]): Promise<void> {
  await page.evaluate(
    ({ targetTabId, targets, runtimeTitle, tabTitle }) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      const state = store.getState()
      state.clearTerminalTabUnread(targetTabId)
      for (const paneKey of targets) {
        state.clearTerminalPaneUnread(paneKey)
        state.removeAgentStatus(paneKey)
      }
      state.updateTabTitle(targetTabId, runtimeTitle)
      state.setTabCustomTitle(targetTabId, tabTitle)
    },
    {
      targetTabId: tabId,
      targets: paneKeys,
      runtimeTitle: OPENCODE_RUNTIME_TITLE,
      tabTitle: TAB_TITLE
    }
  )
}

async function focusSyntheticSplitPane(
  page: Page,
  tabId: string,
  focusedPaneKey: string,
  siblingPaneKey: string
): Promise<void> {
  await page.evaluate(
    ({ targetTabId, focusedKey, siblingKey }) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      const paneKeyPrefix = `${targetTabId}:`
      if (!focusedKey.startsWith(paneKeyPrefix) || !siblingKey.startsWith(paneKeyPrefix)) {
        throw new Error('Synthetic split pane keys must belong to the evidence tab')
      }
      const focusedLeafId = focusedKey.slice(paneKeyPrefix.length)
      const siblingLeafId = siblingKey.slice(paneKeyPrefix.length)
      store.setState((current) => ({
        terminalLayoutsByTabId: {
          ...current.terminalLayoutsByTabId,
          [targetTabId]: {
            ...current.terminalLayoutsByTabId[targetTabId],
            root: {
              type: 'split',
              direction: 'vertical',
              first: { type: 'leaf', leafId: focusedLeafId },
              second: { type: 'leaf', leafId: siblingLeafId }
            },
            activeLeafId: focusedLeafId,
            expandedLeafId: null
          }
        }
      }))
    },
    { targetTabId: tabId, focusedKey: focusedPaneKey, siblingKey: siblingPaneKey }
  )
}

async function snapshotWorktreeLiveness(
  page: Page,
  worktreeId: string
): Promise<WorktreeLivenessSnapshot> {
  return page.evaluate((targetWorktreeId) => {
    const state = window.__store?.getState()
    if (!state) {
      throw new Error('window.__store is not available')
    }
    if ((state.browserTabsByWorktree[targetWorktreeId] ?? []).length > 0) {
      throw new Error('Quiet liveness evidence expects the isolated fixture to have no browser tab')
    }
    return Object.fromEntries(
      (state.tabsByWorktree[targetWorktreeId] ?? []).map((tab) => [
        tab.id,
        state.ptyIdsByTabId[tab.id]
      ])
    )
  }, worktreeId)
}

async function setSyntheticWorktreeLiveness(
  page: Page,
  worktreeId: string,
  isActive: boolean
): Promise<void> {
  await page.evaluate(
    ({ targetWorktreeId, active }) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      const state = store.getState()
      const nextPtyIds = { ...state.ptyIdsByTabId }
      for (const tab of state.tabsByWorktree[targetWorktreeId] ?? []) {
        nextPtyIds[tab.id] = active ? [`e2e-live-${tab.id}`] : []
      }
      store.setState({ ptyIdsByTabId: nextPtyIds })
    },
    { targetWorktreeId: worktreeId, active: isActive }
  )
}

async function restoreWorktreeLiveness(
  page: Page,
  snapshot: WorktreeLivenessSnapshot
): Promise<void> {
  await page.evaluate((previous) => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    const nextPtyIds = { ...store.getState().ptyIdsByTabId }
    for (const [tabId, ptyIds] of Object.entries(previous)) {
      if (ptyIds) {
        nextPtyIds[tabId] = ptyIds
      } else {
        delete nextPtyIds[tabId]
      }
    }
    store.setState({ ptyIdsByTabId: nextPtyIds })
  }, snapshot)
}

async function seedAgentStatus(
  page: Page,
  paneKey: string,
  worktreeId: string,
  tabId: string,
  seed: AgentStatusSeed
): Promise<void> {
  await page.evaluate(
    ({ targetPaneKey, targetWorktreeId, targetTabId, payload }) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      const now = Date.now()
      const agentType = payload.agentType ?? 'opencode'
      store
        .getState()
        .setAgentStatus(
          targetPaneKey,
          { ...payload, agentType },
          agentType === 'codex' ? 'Codex' : 'OpenCode',
          { updatedAt: now, stateStartedAt: now },
          { tabId: targetTabId, worktreeId: targetWorktreeId }
        )
    },
    {
      targetPaneKey: paneKey,
      targetWorktreeId: worktreeId,
      targetTabId: tabId,
      payload: seed
    }
  )
}

async function expectSingleAccessibleLabel(root: Locator, label: string): Promise<void> {
  await expect(root.getByRole('img', { name: label, exact: true })).toHaveCount(1)
  await expect(root.locator(`[aria-label=${JSON.stringify(label)}]`)).toHaveCount(1)
  const snapshot = await root.ariaSnapshot()
  // Why: a child's accessible name also contributes to the sortable tab's
  // aggregate button name. Count exact image nodes, not that valid parent echo.
  expect(countSnapshotImagesNamed(snapshot, label)).toBe(1)
}

async function expectCardLabel(slot: Locator, label: string): Promise<void> {
  await expect(slot).toBeVisible()
  await expect(slot.getByText(label, { exact: true })).toHaveCount(1)
  expect(countOccurrences(await slot.ariaSnapshot(), label)).toBe(1)
}

async function readLeadingGeometry(tab: Locator, lane: Locator): Promise<LeadingGeometry> {
  const tabBox = await tab.boundingBox()
  const laneBox = await lane.boundingBox()
  const titleBox = await tab.getByText(TAB_TITLE, { exact: true }).boundingBox()
  if (!tabBox || !laneBox || !titleBox) {
    throw new Error('OpenCode tab leading lane or title is not measurable')
  }
  return { laneWidth: laneBox.width, titleOffset: titleBox.x - tabBox.x }
}

function expectFixedGeometry(actual: LeadingGeometry, quiet: LeadingGeometry): void {
  expect(Math.round(actual.laneWidth)).toBe(28)
  expect(Math.abs(actual.laneWidth - quiet.laneWidth)).toBeLessThan(0.1)
  expect(Math.abs(actual.titleOffset - quiet.titleOffset)).toBeLessThan(0.1)
}

async function readInactiveOpenCodeMarkContrast(identity: Locator): Promise<{
  opacity: string
  color: string
  mutedColor: string
  ratio: number
}> {
  return identity.evaluate((node) => {
    const resolveColor = (value: string): string => {
      const probe = document.createElement('span')
      probe.style.color = value
      document.body.appendChild(probe)
      const color = getComputedStyle(probe).color
      probe.remove()
      return color
    }
    const rgb = (value: string): [number, number, number] => {
      const channels = value
        .match(/[\d.]+/g)
        ?.slice(0, 3)
        .map(Number)
      if (!channels || channels.length !== 3) {
        throw new Error(`Expected an RGB color, got ${value}`)
      }
      return channels as [number, number, number]
    }
    const luminance = (value: string): number => {
      const channels = rgb(value).map((channel) => {
        const normalized = channel / 255
        return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
      })
      return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
    }
    const styles = getComputedStyle(node)
    const color = styles.color
    const rootStyles = getComputedStyle(document.documentElement)
    const mutedColor = resolveColor(rootStyles.getPropertyValue('--muted-foreground'))
    const cardColor = resolveColor(rootStyles.getPropertyValue('--card'))
    const lighter = Math.max(luminance(color), luminance(cardColor))
    const darker = Math.min(luminance(color), luminance(cardColor))
    return { opacity: styles.opacity, color, mutedColor, ratio: (lighter + 0.05) / (darker + 0.05) }
  })
}

async function captureEvidence(
  tab: Locator,
  row: Locator,
  theme: Theme,
  stateName: string
): Promise<void> {
  if (!CAPTURE_EVIDENCE) {
    return
  }
  // Why: evidence is opt-in and temp-only so normal E2E runs never dirty the repo.
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  await tab.screenshot({ path: join(EVIDENCE_DIR, `${theme}-${stateName}-tab.png`) })
  await row.screenshot({ path: join(EVIDENCE_DIR, `${theme}-${stateName}-sidebar.png`) })
}

async function expectQuietState(
  page: Page,
  tabId: string,
  worktreeId: string,
  theme: Theme,
  expectedStatus: 'active' | 'inactive'
): Promise<LeadingGeometry> {
  const tab = terminalTab(page, tabId)
  const identity = tab.locator('[data-agent-icon="opencode"]')
  await expect(tab).toHaveAttribute('data-agent-activity-status', expectedStatus)
  await expect(identity).toBeVisible()
  await expect(tab.locator('[data-testid="tab-agent-activity-indicator"]')).toHaveCount(0)
  await expect(tab.locator('[data-testid="tab-activity-bell"]')).toHaveCount(0)
  await expectSingleAccessibleLabel(tab, 'OpenCode')

  const svg = identity.locator('svg')
  await expect(svg).toHaveAttribute('width', '12')
  await expect(svg).toHaveAttribute('height', '12')
  await expect(svg).toHaveAttribute('viewBox', '0 0 512 512')
  const lane = identity.locator('..')
  const geometry = await readLeadingGeometry(tab, lane)
  expect(Math.round(geometry.laneWidth)).toBe(28)

  if (theme === 'light' && expectedStatus === 'inactive') {
    const contrast = await readInactiveOpenCodeMarkContrast(identity)
    expect(contrast.opacity).toBe('1')
    expect(contrast.color).toBe(contrast.mutedColor)
    expect(contrast.ratio).toBeGreaterThanOrEqual(3)
  }

  const slot = statusSlot(page, worktreeId)
  const quietLabel = expectedStatus === 'active' ? 'Active' : 'Inactive'
  await expectCardLabel(slot, quietLabel)
  await captureEvidence(tab, worktreeRow(page, worktreeId), theme, `quiet-${expectedStatus}`)
  return geometry
}

async function expectAgentState(
  page: Page,
  tabId: string,
  worktreeId: string,
  theme: Theme,
  expected: StateExpectation,
  quietGeometry: LeadingGeometry
): Promise<void> {
  const tab = terminalTab(page, tabId)
  const activity = tab.locator('[data-testid="tab-agent-activity-indicator"]')
  await expect(tab).toHaveAttribute('data-agent-activity-status', expected.tabStatus)
  await expect(activity).toBeVisible()
  await expect(activity).toHaveAttribute('data-agent-activity-status', expected.tabStatus)
  await expect(activity.locator(expected.tabStyle)).toBeVisible()
  await expect(tab.locator('[data-agent-icon="opencode"]')).toBeVisible()
  await expectSingleAccessibleLabel(tab, expected.tabLabel)
  expectFixedGeometry(await readLeadingGeometry(tab, activity), quietGeometry)

  const slot = statusSlot(page, worktreeId)
  await expectCardLabel(slot, expected.cardLabel)
  if (expected.cardStyle) {
    await expect(slot.locator(expected.cardStyle)).toBeVisible()
  }
  const group = agentGroup(page, worktreeId)
  await expect(group).toBeVisible()
  await expect(group.locator(`[aria-label=${JSON.stringify(expected.rowLabel)}]`)).toHaveCount(1)
  if (expected.rowLabel !== 'Interrupted by user') {
    await expect(group.getByRole('img', { name: expected.rowLabel, exact: true })).toHaveCount(1)
  }
  if (expected.toolText) {
    await expect(group.getByText(expected.toolText, { exact: true })).toBeVisible()
  }
  await captureEvidence(tab, worktreeRow(page, worktreeId), theme, expected.evidenceName)
}

const WORKING: AgentStatusSeed = {
  state: 'working',
  prompt: 'Polish the status chrome',
  toolName: 'Read',
  toolInput: 'src/renderer/src/components/tab-bar/TerminalTabLeadingIcon.tsx'
}

const WAITING_PERMISSION: AgentStatusSeed = {
  state: 'waiting',
  prompt: 'Run the focused checks?',
  toolName: 'bash',
  toolInput: 'pnpm test'
}

const WAITING_QUESTION: AgentStatusSeed = {
  state: 'waiting',
  prompt: 'Choose the release path',
  toolName: 'AskUserQuestion',
  interactivePrompt: JSON.stringify({
    questions: [
      {
        question: 'Ship the status polish now?',
        header: 'Release',
        options: [{ label: 'Ship', description: 'Continue with the release.' }],
        multiSelect: false
      }
    ]
  })
}

const BLOCKED: AgentStatusSeed = {
  state: 'blocked',
  prompt: 'Resolve the failed status check',
  toolName: 'ModelNotFoundError',
  toolInput: 'Model example/missing-model is unavailable.'
}

const DONE: AgentStatusSeed = {
  state: 'done',
  prompt: 'Polish the status chrome',
  lastAssistantMessage: 'All status checks passed.'
}

const INTERRUPTED: AgentStatusSeed = {
  ...DONE,
  interrupted: true,
  lastAssistantMessage: 'Stopped safely.'
}

const STATE_EXPECTATIONS: {
  seed: AgentStatusSeed
  expected: StateExpectation
}[] = [
  {
    seed: WORKING,
    expected: {
      evidenceName: 'working',
      tabStatus: 'working',
      tabLabel: 'OpenCode · Working',
      cardLabel: 'Working',
      rowLabel: 'Working',
      tabStyle: '.border-status-working',
      toolText: 'Read'
    }
  },
  {
    seed: WAITING_PERMISSION,
    expected: {
      evidenceName: 'waiting-permission',
      tabStatus: 'permission',
      tabLabel: 'OpenCode · Needs attention',
      cardLabel: 'Needs attention',
      rowLabel: 'Waiting for input',
      tabStyle: '.bg-status-attention',
      toolText: 'bash'
    }
  },
  {
    seed: WAITING_QUESTION,
    expected: {
      evidenceName: 'waiting-question',
      tabStatus: 'permission',
      tabLabel: 'OpenCode · Needs attention',
      cardLabel: 'Needs attention',
      rowLabel: 'Waiting for input',
      tabStyle: '.bg-status-attention',
      toolText: 'AskUserQuestion'
    }
  },
  {
    seed: BLOCKED,
    expected: {
      evidenceName: 'blocked',
      tabStatus: 'blocked',
      tabLabel: 'OpenCode · Blocked',
      cardLabel: 'Blocked',
      rowLabel: 'Blocked',
      tabStyle: '.bg-destructive',
      cardStyle: '.bg-destructive',
      toolText: 'ModelNotFoundError'
    }
  },
  {
    seed: DONE,
    expected: {
      evidenceName: 'done',
      tabStatus: 'done',
      tabLabel: 'OpenCode · Done',
      cardLabel: 'Done',
      rowLabel: 'Done',
      tabStyle: '.text-status-success'
    }
  },
  {
    seed: INTERRUPTED,
    expected: {
      evidenceName: 'interrupted',
      tabStatus: 'interrupted',
      tabLabel: 'OpenCode · Interrupted',
      cardLabel: 'Interrupted',
      rowLabel: 'Interrupted by user',
      tabStyle: '.bg-destructive',
      cardStyle: '.bg-destructive'
    }
  }
]

test('OpenCode status chrome stays aligned, accessible, and truthful', async ({ orcaPage }) => {
  test.slow()
  const consoleErrors: string[] = []
  const pageErrors: string[] = []
  orcaPage.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text())
    }
  })
  orcaPage.on('pageerror', (error) => pageErrors.push(error.message))

  await waitForSessionReady(orcaPage)
  const worktreeId = await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)

  // Why: status hooks are transport-tested elsewhere; direct seeding isolates the
  // real tab/sidebar render contract from PTY timing and works for local, WSL, and SSH tabs.
  const { tabId, paneKeys } = await configureStatusEvidence(orcaPage, worktreeId)
  await expect(terminalTab(orcaPage, tabId)).toBeVisible()
  const [primaryPaneKey, secondPaneKey, thirdPaneKey] = paneKeys
  if (!primaryPaneKey || !secondPaneKey || !thirdPaneKey) {
    throw new Error('Expected three stable OpenCode pane keys')
  }

  for (const theme of ['light', 'dark'] as const) {
    await setTheme(orcaPage, theme)
    await clearSeededState(orcaPage, tabId, paneKeys)
    // Why: status liveness reads this map for native, WSL, and SSH tabs. Snapshotting
    // and restoring it proves both quiet states without killing the fixture's real PTY.
    const livenessSnapshot = await snapshotWorktreeLiveness(orcaPage, worktreeId)
    await setSyntheticWorktreeLiveness(orcaPage, worktreeId, true)
    const quietGeometry = await expectQuietState(orcaPage, tabId, worktreeId, theme, 'active')
    await setSyntheticWorktreeLiveness(orcaPage, worktreeId, false)
    await expectQuietState(orcaPage, tabId, worktreeId, theme, 'inactive')
    await restoreWorktreeLiveness(orcaPage, livenessSnapshot)

    for (const { seed, expected } of STATE_EXPECTATIONS) {
      await seedAgentStatus(orcaPage, primaryPaneKey, worktreeId, tabId, seed)
      await expectAgentState(orcaPage, tabId, worktreeId, theme, expected, quietGeometry)
    }

    // Why: unread is a passive notification over successful completion;
    // destructive interruption must keep its newer, more specific red glyph.
    await seedAgentStatus(orcaPage, primaryPaneKey, worktreeId, tabId, DONE)
    await orcaPage.evaluate((targetTabId) => {
      window.__store?.getState().markTerminalTabUnread(targetTabId)
    }, tabId)
    const tab = terminalTab(orcaPage, tabId)
    const bell = tab.locator('[data-testid="tab-activity-bell"]')
    await expect(bell).toBeVisible()
    await expect(bell).toHaveAttribute('data-unread-kind', 'terminal-activity')
    await expectSingleAccessibleLabel(tab, 'OpenCode · Unread terminal activity')
    expectFixedGeometry(await readLeadingGeometry(tab, bell), quietGeometry)
    await captureEvidence(tab, worktreeRow(orcaPage, worktreeId), theme, 'unread-terminal')

    await orcaPage.evaluate((targetPaneKey) => {
      window.__store?.getState().markAgentCompletionPaneUnread(targetPaneKey)
    }, primaryPaneKey)
    await expect(bell).toHaveAttribute('data-unread-kind', 'agent-completion')
    await expectSingleAccessibleLabel(tab, 'OpenCode · Unread agent completion')
    expectFixedGeometry(await readLeadingGeometry(tab, bell), quietGeometry)
    await captureEvidence(tab, worktreeRow(orcaPage, worktreeId), theme, 'unread-completion')

    await seedAgentStatus(orcaPage, primaryPaneKey, worktreeId, tabId, INTERRUPTED)
    await expect(tab).toHaveAttribute('data-agent-activity-status', 'interrupted')
    await expect(bell).toHaveCount(0)
    await expectSingleAccessibleLabel(tab, 'OpenCode · Interrupted')
  }

  await clearSeededState(orcaPage, tabId, paneKeys)
  await orcaPage.emulateMedia({ reducedMotion: 'no-preference' })
  await seedAgentStatus(orcaPage, primaryPaneKey, worktreeId, tabId, WORKING)
  const tabSpinner = terminalTab(orcaPage, tabId).locator('.border-status-working')
  const cardSpinner = statusSlot(orcaPage, worktreeId).locator('.border-status-working')
  await expect(tabSpinner).toBeVisible()
  await expect(cardSpinner).toBeVisible()
  expect(await tabSpinner.evaluate((node) => getComputedStyle(node).animationName)).toBe('spin')
  expect(await cardSpinner.evaluate((node) => getComputedStyle(node).animationName)).toBe('spin')
  await terminalTab(orcaPage, tabId).locator('[data-testid="tab-agent-activity-indicator"]').hover()
  const tooltip = orcaPage
    .locator('[data-slot="tooltip-content"]')
    .filter({ hasText: 'OpenCode · Working' })
  await expect(tooltip).toBeVisible()
  expect(await tooltip.evaluate((node) => getComputedStyle(node).animationName)).not.toBe('none')

  await orcaPage.emulateMedia({ reducedMotion: 'reduce' })
  expect(await tabSpinner.evaluate((node) => getComputedStyle(node).animationName)).toBe('none')
  expect(await cardSpinner.evaluate((node) => getComputedStyle(node).animationName)).toBe('none')
  expect(await tooltip.evaluate((node) => getComputedStyle(node).animationName)).toBe('none')
  await orcaPage.emulateMedia({ reducedMotion: 'no-preference' })

  await clearSeededState(orcaPage, tabId, paneKeys)
  await seedAgentStatus(orcaPage, primaryPaneKey, worktreeId, tabId, WORKING)
  await seedAgentStatus(orcaPage, secondPaneKey, worktreeId, tabId, WAITING_PERMISSION)
  await seedAgentStatus(orcaPage, thirdPaneKey, worktreeId, tabId, BLOCKED)
  await expect(terminalTab(orcaPage, tabId)).toHaveAttribute(
    'data-agent-activity-status',
    'blocked'
  )
  await expectSingleAccessibleLabel(terminalTab(orcaPage, tabId), 'OpenCode · Blocked')
  await expectCardLabel(statusSlot(orcaPage, worktreeId), 'Blocked')

  await clearSeededState(orcaPage, tabId, paneKeys)
  await seedAgentStatus(orcaPage, primaryPaneKey, worktreeId, tabId, INTERRUPTED)
  await seedAgentStatus(orcaPage, secondPaneKey, worktreeId, tabId, WORKING)
  await seedAgentStatus(orcaPage, thirdPaneKey, worktreeId, tabId, WAITING_PERMISSION)
  await expect(terminalTab(orcaPage, tabId)).toHaveAttribute(
    'data-agent-activity-status',
    'permission'
  )
  await expectSingleAccessibleLabel(terminalTab(orcaPage, tabId), 'OpenCode · Needs attention')
  await expectCardLabel(statusSlot(orcaPage, worktreeId), 'Needs attention')

  await clearSeededState(orcaPage, tabId, paneKeys)
  await seedAgentStatus(orcaPage, primaryPaneKey, worktreeId, tabId, INTERRUPTED)
  await seedAgentStatus(orcaPage, secondPaneKey, worktreeId, tabId, DONE)
  await expect(terminalTab(orcaPage, tabId)).toHaveAttribute(
    'data-agent-activity-status',
    'interrupted'
  )
  await expectSingleAccessibleLabel(terminalTab(orcaPage, tabId), 'OpenCode · Interrupted')
  await expectCardLabel(statusSlot(orcaPage, worktreeId), 'Interrupted')

  await clearSeededState(orcaPage, tabId, paneKeys)
  await focusSyntheticSplitPane(orcaPage, tabId, primaryPaneKey, secondPaneKey)
  const mixedTab = terminalTab(orcaPage, tabId)

  // Why: the focused pane identifies the tab, but the highest-priority sibling
  // owns live status chrome. Assert both sides through rendered provider glyphs.
  await seedAgentStatus(orcaPage, primaryPaneKey, worktreeId, tabId, {
    ...WORKING,
    agentType: 'codex'
  })
  await seedAgentStatus(orcaPage, secondPaneKey, worktreeId, tabId, DONE)
  await expectSingleAccessibleLabel(mixedTab, 'Codex · Working')
  await expect(
    mixedTab.locator('[data-testid="tab-agent-activity-indicator"] [data-agent-icon="codex"]')
  ).toBeVisible()

  await seedAgentStatus(orcaPage, secondPaneKey, worktreeId, tabId, BLOCKED)
  await expectSingleAccessibleLabel(mixedTab, 'OpenCode · Blocked')
  const siblingOwnedIndicator = mixedTab.locator('[data-testid="tab-agent-activity-indicator"]')
  await expect(siblingOwnedIndicator.locator('[data-agent-icon="opencode"]')).toBeVisible()
  await expect(siblingOwnedIndicator.locator('[data-agent-icon="codex"]')).toHaveCount(0)

  await clearSeededState(orcaPage, tabId, paneKeys)
  await seedAgentStatus(orcaPage, primaryPaneKey, worktreeId, tabId, {
    ...BLOCKED,
    agentType: 'codex'
  })
  await seedAgentStatus(orcaPage, secondPaneKey, worktreeId, tabId, BLOCKED)
  await expectSingleAccessibleLabel(mixedTab, 'Blocked')
  const mixedProviderIndicator = mixedTab.locator('[data-testid="tab-agent-activity-indicator"]')
  await expect(mixedProviderIndicator.locator('[data-agent-icon]')).toHaveCount(0)
  await expect(mixedTab.locator('[data-agent-icon]')).toHaveCount(0)
  await captureEvidence(mixedTab, worktreeRow(orcaPage, worktreeId), 'dark', 'mixed-provider')

  await clearSeededState(orcaPage, tabId, paneKeys)
  await seedAgentStatus(orcaPage, primaryPaneKey, worktreeId, tabId, {
    ...DONE,
    agentType: 'codex'
  })
  await seedAgentStatus(orcaPage, secondPaneKey, worktreeId, tabId, DONE)
  await orcaPage.evaluate((paneKey) => {
    window.__store?.getState().markAgentCompletionPaneUnread(paneKey)
  }, secondPaneKey)
  const siblingUnreadBell = mixedTab.locator('[data-testid="tab-activity-bell"]')
  await expect(siblingUnreadBell).toHaveAttribute('data-unread-kind', 'agent-completion')
  await expectSingleAccessibleLabel(mixedTab, 'OpenCode · Unread agent completion')
  await expect(siblingUnreadBell.locator('[data-agent-icon="opencode"]')).toBeVisible()
  await expect(siblingUnreadBell.locator('[data-agent-icon="codex"]')).toHaveCount(0)

  expect(consoleErrors).toEqual([])
  expect(pageErrors).toEqual([])
})
