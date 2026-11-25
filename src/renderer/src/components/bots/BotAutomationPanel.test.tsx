// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import type { Bot } from '../../../../shared/bot-types'
import type { Automation } from '../../../../shared/automations/automation-definition'
import type { AutomationRun } from '../../../../shared/automations/history/automation-run'
import { makeAutomation, makeRun } from '../automations/automations-page-fixtures'
import { BotAutomationPanel } from './BotAutomationPanel'
import { clearRetainedBotAutomationDrafts } from './bot-automation-drafts'
import type { BotAutomationPlace } from './bot-automation-place'

const bot: Bot = {
  id: 'b1',
  name: 'Pixel',
  hostId: 'local',
  folder: 'pixel',
  folderWorkspaceId: 'home-1',
  agent: 'claude',
  avatar: 'mascot:Q1',
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  linear: null,
  github: null,
  chatSessionId: null,
  createdAt: 1,
  updatedAt: 1
}

const AUTOMATION: Automation = makeAutomation({
  id: 'a1',
  name: 'Daily PR digest',
  prompt: 'Post the digest',
  rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0',
  dtstart: 1_700_000_000_000,
  nextRunAt: 1_700_100_000_000,
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  workspaceMode: 'existing',
  bot: { botId: 'b1', runsIn: 'new', resultsTo: 'chat' },
  on: []
})

function run(id: string, createdAt: number): AutomationRun {
  return makeRun({
    id,
    automationId: 'a1',
    title: `Run ${id}`,
    createdAt,
    startedAt: createdAt,
    outputSnapshot: {
      format: 'plain_text',
      content: `output ${id}`,
      capturedAt: 1,
      truncated: false
    },
    sessionKind: 'chat'
  })
}

const host = vi.hoisted(() => ({
  show: vi.fn(),
  readRun: vi.fn(),
  listRunsPage: vi.fn(),
  update: vi.fn(),
  runNow: vi.fn(),
  remove: vi.fn(),
  openChat: vi.fn(async () => true),
  offline: false,
  terminal: vi.fn()
}))

vi.mock('../automations/hosts/automation-owner-reads', () => ({
  showAutomationForOwner: host.show,
  readAutomationRunForOwner: host.readRun
}))
vi.mock('../automations/hosts/automation-scoped-list-client', () => ({
  listAutomationRunsPageForOwner: host.listRunsPage,
  updateAutomationForOwner: host.update,
  runAutomationNowForOwner: host.runNow,
  deleteAutomationForOwner: host.remove
}))
vi.mock('@/lib/bot-host-views', () => ({ useBotHostOffline: () => host.offline }))
vi.mock('@/lib/bot-catalog', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  openBotHomeTab: host.openChat,
  useBotWebhooks: () => true,
  useBotThreadReplies: () => false,
  useBots: () => [bot],
  useBotsEnabled: () => true
}))
vi.mock('./orca-cloud-signed-out', () => ({ useOrcaCloudSignedOut: () => false }))
vi.mock('@/lib/open-orchestration-worker', () => ({ revealWorkerPane: host.terminal }))
vi.mock('@/lib/agent-catalog/agent-catalog', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getAgentCatalog: () => []
}))

const place: BotAutomationPlace = {
  bot: { hostId: 'local', id: 'b1' },
  automationId: 'a1',
  runId: null,
  originRowKey: 'auto:a1',
  originScrollTop: 0
}

function renderPanel(overrides: Partial<BotAutomationPlace> = {}) {
  const onBack = vi.fn()
  const onDeleted = vi.fn()
  const view = render(
    <TooltipProvider>
      <div style={{ width: 220 }}>
        <BotAutomationPanel
          bot={bot}
          place={{ ...place, ...overrides }}
          onBack={onBack}
          onDeleted={onDeleted}
        />
      </div>
    </TooltipProvider>
  )
  return { ...view, onBack, onDeleted }
}

beforeEach(() => {
  host.offline = false
  host.show.mockResolvedValue(AUTOMATION)
  host.listRunsPage.mockResolvedValue({ runs: [run('r1', 1000), run('r2', 900)], nextCursor: null })
  host.readRun.mockResolvedValue({ kind: 'run-missing' })
  host.update.mockImplementation(async (_owner, _id, updates) => ({ ...AUTOMATION, ...updates }))
  vi.stubGlobal('api', {
    ui: { writeClipboardText: vi.fn(async () => undefined) },
    preflight: { detectAgents: vi.fn(async () => []) }
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  clearRetainedBotAutomationDrafts()
})

describe("a bot's Automation screen", () => {
  it('opens the full page from the menu with the displayed host and no selected run', async () => {
    const previous = useAppStore.getState()
    const navigate = vi.fn()
    const open = vi.fn()
    useAppStore.setState({ setPendingAutomationRunNavigation: navigate, openAutomationsPage: open })
    try {
      renderPanel({ runId: 'old-run' })
      const menu = await screen.findByRole('button', { name: 'More actions for Daily PR digest' })
      fireEvent.pointerDown(menu, { button: 0, ctrlKey: false })
      fireEvent.click(await screen.findByRole('menuitem', { name: /Open in Automations/ }))
      expect(navigate).toHaveBeenCalledWith({ automationId: 'a1', runId: null, hostId: 'local' })
      expect(open).toHaveBeenCalled()
    } finally {
      useAppStore.setState({
        setPendingAutomationRunNavigation: previous.setPendingAutomationRunNavigation,
        openAutomationsPage: previous.openAutomationsPage
      })
    }
  })

  it('opens the running terminal and hides the action when a run has no destination', async () => {
    host.listRunsPage.mockResolvedValue({
      runs: [
        {
          ...run('live', 1000),
          status: 'dispatched',
          sessionKind: 'terminal',
          chatSessionId: null,
          terminalPaneKey: 'pane-live',
          workspaceId: 'workspace-live'
        }
      ],
      nextCursor: null
    })
    const view = renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: 'Open terminal' }))
    expect(host.terminal).toHaveBeenCalledWith('workspace-live', 'pane-live', undefined)
    view.unmount()
    host.listRunsPage.mockResolvedValue({
      runs: [
        {
          ...run('no-destination', 1000),
          status: 'dispatched',
          sessionKind: 'terminal',
          chatSessionId: null,
          terminalPaneKey: null,
          workspaceId: null
        }
      ],
      nextCursor: null
    })
    renderPanel()
    await screen.findByRole('button', { name: 'Running…' })
    expect(screen.queryByRole('button', { name: 'Open terminal' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Open chat' })).toBeNull()
  })

  it('opens on the screen region with the page’s sections', async () => {
    renderPanel()
    await screen.findByRole('heading', { name: 'Daily PR digest' })
    expect(document.activeElement?.getAttribute('data-bot-automation-screen')).toBe('')
    expect(screen.getByText('When')).toBeTruthy()
    expect(screen.getByText('Results')).toBeTruthy()
    expect(screen.getByText('Instructions')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Edit in chat' })).toBeTruthy()
    expect(screen.getByRole('switch', { name: 'Daily PR digest' })).toBeTruthy()
  })

  it('goes back on Escape, but not while typing in a field', async () => {
    const { onBack } = renderPanel()
    await screen.findByRole('heading', { name: 'Daily PR digest' })
    const region = screen.getByRole('region', { name: 'Daily PR digest' })
    const input = document.createElement('input')
    region.appendChild(input)
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onBack).not.toHaveBeenCalled()
    fireEvent.keyDown(region, { key: 'Escape' })
    expect(onBack).toHaveBeenCalledOnce()
  })

  it('expands a run in place', async () => {
    renderPanel()
    const row = await screen.findByRole('button', { name: /Run r1/ })
    expect(row.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(row)
    expect(row.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('output r1')).toBeTruthy()
  })

  it('pins an asked-for run that is older than the newest ones', async () => {
    host.readRun.mockResolvedValue({ kind: 'run', run: run('old', 10) })
    renderPanel({ runId: 'old' })
    expect(await screen.findByText(/Opened run/)).toBeTruthy()
    expect(screen.getByText('output old')).toBeTruthy()
  })

  it('holds Save until the draft changes, then saves and returns focus to Edit', async () => {
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: 'Edit where results go' }))
    const save = screen.getByRole('button', { name: 'Save' })
    expect(save.getAttribute('aria-disabled')).toBe('true')
    expect(save.className).toContain('aria-disabled:opacity-50')
    fireEvent.click(save)
    expect(host.update).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('switch', { name: 'Let Pixel react' }))
    const changedSave = screen.getByRole('button', { name: 'Save' })
    expect(changedSave.getAttribute('aria-disabled')).toBeNull()
    fireEvent.click(changedSave)
    await waitFor(() =>
      expect(document.activeElement?.getAttribute('aria-label')).toBe('Edit where results go')
    )
  })

  it('keeps Run now disabled after the request resolves to a running run', async () => {
    host.runNow.mockResolvedValue({
      ...run('manual', 2000),
      status: 'dispatched',
      trigger: 'manual',
      chatSessionId: 'chat-new'
    })
    host.listRunsPage.mockResolvedValue({ runs: [], nextCursor: null })
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: 'Run now' }))
    const running = await screen.findByRole('button', { name: 'Running…' })
    expect(running.getAttribute('aria-disabled')).toBe('true')
    expect(
      document.getElementById(running.getAttribute('aria-describedby') ?? '')?.textContent
    ).toContain('Open chat')
    fireEvent.click(running)
    expect(host.runNow).toHaveBeenCalledOnce()
    expect(await screen.findByText('Run started')).toBeTruthy()
  })

  it('offers chat or terminal on expanded runs without a page link', async () => {
    host.listRunsPage.mockResolvedValue({
      runs: [
        { ...run('chat', 1000), chatSessionId: 'c1' },
        {
          ...run('terminal', 900),
          sessionKind: 'terminal',
          terminalPaneKey: 'p1',
          workspaceId: 'w1'
        }
      ],
      nextCursor: null
    })
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: /Run chat/ }))
    expect(screen.getByRole('button', { name: 'Open chat' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Open in Automations/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Run terminal/ }))
    expect(screen.getByRole('button', { name: 'Open terminal' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Open in Automations/ })).toBeNull()
  })

  it('focuses Retry when Edit in chat fails', async () => {
    host.openChat.mockResolvedValueOnce(false)
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: 'Edit in chat' }))
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Retry' }))
    )
  })

  it('asks before Back discards an open edit', async () => {
    const { onBack } = renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: 'Edit where results go' }))
    fireEvent.click(screen.getByRole('button', { name: 'Back to Activity' }))
    expect(onBack).not.toHaveBeenCalled()
    expect(await screen.findByText('Discard changes to Results?')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(onBack).toHaveBeenCalledOnce()
  })

  it('keeps an open edit when the screen unmounts for another reason', async () => {
    const first = renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: 'Edit where results go' }))
    first.unmount()
    renderPanel()
    expect(await screen.findByText('Unsaved change kept from earlier')).toBeTruthy()
  })

  it('says why host actions are off while offline, and keeps them focusable', async () => {
    host.offline = true
    renderPanel()
    const runNow = await screen.findByRole('button', { name: 'Run now' })
    expect(runNow.getAttribute('aria-disabled')).toBe('true')
    const describedBy = runNow.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    expect(document.getElementById(describedBy ?? '')?.textContent).toContain('offline')
    fireEvent.click(runNow)
    expect(host.runNow).not.toHaveBeenCalled()
  })

  it('Check again releases the unconfirmed request when its new manual run is found', async () => {
    host.runNow.mockRejectedValue(new Error('socket closed'))
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: 'Run now' }))
    await screen.findByText("Couldn't confirm the run started")
    host.listRunsPage.mockResolvedValue({
      runs: [{ ...run('new', 2000), trigger: 'manual', status: 'completed' }],
      nextCursor: null
    })
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await waitFor(() => expect(screen.queryByText("Couldn't confirm the run started")).toBeNull())
    expect(screen.getByRole('button', { name: 'Run now' }).getAttribute('aria-disabled')).toBeNull()
    expect(host.runNow).toHaveBeenCalledOnce()
  })

  it('announces an unsuccessful Check again without resending Run now', async () => {
    host.runNow.mockRejectedValue(new Error('socket closed'))
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: 'Run now' }))
    await screen.findByText("Couldn't confirm the run started")
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    expect(await screen.findByText("Still couldn't confirm")).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Run now' }).getAttribute('aria-disabled')).toBe(
      'true'
    )
    expect(host.runNow).toHaveBeenCalledOnce()
  })

  it('holds Run now after a press whose answer was lost, until checked or dismissed', async () => {
    host.runNow.mockRejectedValue(new Error('socket closed'))
    renderPanel()
    const runNow = await screen.findByRole('button', { name: 'Run now' })
    await act(async () => {
      fireEvent.click(runNow)
    })
    expect(await screen.findByText("Couldn't confirm the run started")).toBeTruthy()
    const held = screen.getByRole('button', { name: 'Run now' })
    expect(held.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(held)
    expect(host.runNow).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    fireEvent.click(screen.getByRole('button', { name: 'Run again…' }))
    expect(host.runNow).toHaveBeenCalledOnce()
    expect(screen.getByRole('dialog', { name: 'Run again?' })).toBeTruthy()
  })
})
