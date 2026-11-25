// @vitest-environment happy-dom
// When the Automation screen says its computer needs an update to edit here: only once that host
// answered without the write-time guard, or refused a save for it.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { Bot } from '../../../../shared/bot-types'
import type { Automation } from '../../../../shared/automations/automation-definition'
import type { AutomationRun } from '../../../../shared/automations/history/automation-run'
import type { AutomationOwnerRef } from '../../../../shared/automations/ownership/automation-owner-ref'
import { makeAutomation, makeRun } from '../automations/automations-page-fixtures'
import { AutomationHostScopeUnsupportedError } from '../automations/hosts/automation-capability-probe'
import { BotAutomationPanel } from './BotAutomationPanel'
import { clearRetainedBotAutomationDrafts } from './bot-automation-drafts'
import type { BotAutomationPlace } from './bot-automation-place'

const bot: Bot = {
  id: 'b1',
  name: 'Pixel',
  // Bots type their host as this computer; the paired owner below is what the screen acts through.
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

const OWNER: AutomationOwnerRef = {
  authority: { kind: 'runtime', environmentId: 'env-1', pairingRevision: 1 },
  selector: { kind: 'self' }
}

function run(id: string, createdAt: number, status: AutomationRun['status']): AutomationRun {
  return makeRun({
    id,
    automationId: 'a1',
    title: `Run ${id}`,
    createdAt,
    startedAt: createdAt,
    status,
    sessionKind: 'chat',
    chatSessionId: 'chat-1'
  })
}

const host = vi.hoisted(() => ({
  // Typed by a return, so tests can set any answer.
  guard: ((): 'unknown' | 'supported' | 'unsupported' => 'unknown')(),
  show: vi.fn(),
  readRun: vi.fn(),
  listRunsPage: vi.fn(),
  update: vi.fn()
}))

vi.mock('@/runtime/rpc/compatibility/use-runtime-environment-capability', () => ({
  useRuntimeEnvironmentCapabilityAnswer: () => host.guard,
  useRuntimeEnvironmentCapability: () => host.guard === 'supported'
}))
vi.mock('../automations/hosts/automation-host-owner', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  automationOwnerForHostId: () => OWNER,
  evaluateAutomationOwner: (owner: AutomationOwnerRef) => ({ status: 'same', owner })
}))
vi.mock('../automations/hosts/automation-owner-reads', () => ({
  showAutomationForOwner: host.show,
  readAutomationRunForOwner: host.readRun
}))
vi.mock('../automations/hosts/automation-scoped-list-client', () => ({
  listAutomationRunsPageForOwner: host.listRunsPage,
  updateAutomationForOwner: host.update,
  runAutomationNowForOwner: vi.fn(),
  deleteAutomationForOwner: vi.fn()
}))
vi.mock('./use-bot-host-label', () => ({ useBotHostLabel: () => 'Studio Mac' }))
vi.mock('@/lib/bot-host-views', () => ({ useBotHostOffline: () => false }))
vi.mock('@/lib/bot-catalog', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  openBotHomeTab: vi.fn(async () => true),
  useBotWebhooks: () => true,
  useBotThreadReplies: () => false,
  useBots: () => [bot],
  useBotsEnabled: () => true
}))
vi.mock('./orca-cloud-signed-out', () => ({ useOrcaCloudSignedOut: () => false }))
vi.mock('@/lib/agent-catalog/agent-catalog', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getAgentCatalog: () => []
}))

const place: BotAutomationPlace = {
  bot: { hostId: bot.hostId, id: 'b1' },
  automationId: 'a1',
  runId: null,
  originRowKey: 'a1',
  originScrollTop: 0
}

function panel(): React.JSX.Element {
  return (
    <TooltipProvider>
      <BotAutomationPanel bot={bot} place={place} onBack={vi.fn()} onDeleted={vi.fn()} />
    </TooltipProvider>
  )
}

const EDIT_NOTICE = 'Update Orca on Studio Mac to edit here.'

beforeEach(() => {
  host.guard = 'unknown'
  host.show.mockResolvedValue(AUTOMATION)
  host.listRunsPage.mockResolvedValue({ runs: [run('r1', 1000, 'completed')], nextCursor: null })
  host.readRun.mockResolvedValue({ kind: 'run-missing' })
  host.update.mockImplementation(async (_owner, _id, updates) => ({ ...AUTOMATION, ...updates }))
  vi.stubGlobal('api', {
    ui: { writeClipboardText: vi.fn(async () => undefined) },
    preflight: { detectAgents: vi.fn(async () => []) }
  })
})

afterEach(() => {
  cleanup()
  clearRetainedBotAutomationDrafts()
  vi.unstubAllGlobals()
})

describe('the old-host save guard on a paired computer', () => {
  it('says nothing and leaves Edit on while the host has not answered', async () => {
    render(panel())
    const edit = await screen.findByRole('button', { name: 'Edit where results go' })
    expect(edit.getAttribute('aria-disabled')).toBeNull()
    expect(screen.queryByText(/Update Orca/)).toBeNull()
  })

  it('names the host and turns Edit off once it answers without the guard', async () => {
    host.guard = 'unsupported'
    render(panel())
    expect(await screen.findByText(EDIT_NOTICE)).toBeTruthy()
    const edit = screen.getByRole('button', { name: 'Edit where results go' })
    expect(edit.getAttribute('aria-disabled')).toBe('true')
  })

  it('keeps the Running notice ahead of the edit-only update notice', async () => {
    host.guard = 'unsupported'
    host.listRunsPage.mockResolvedValue({
      runs: [run('live', 1000, 'dispatched')],
      nextCursor: null
    })
    render(panel())
    expect(await screen.findByRole('button', { name: 'Open chat' })).toBeTruthy()
    expect(screen.getByText('Running')).toBeTruthy()
    expect(screen.queryByText(EDIT_NOTICE)).toBeNull()
  })

  it('says beside Save when the host refuses it, and drops that once the host answers anew', async () => {
    host.update.mockRejectedValue(
      new AutomationHostScopeUnsupportedError(
        'Update Orca on this computer to edit these settings.'
      )
    )
    const view = render(panel())
    fireEvent.click(await screen.findByRole('button', { name: 'Edit where results go' }))
    fireEvent.click(screen.getByRole('switch', { name: 'Let Pixel react' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Update Orca on Studio Mac to save here.')).toBeTruthy()
    expect(screen.getByText(EDIT_NOTICE)).toBeTruthy()

    // The host was updated and answered with the guard: the refusal no longer speaks for it.
    host.guard = 'supported'
    view.rerender(panel())
    await waitFor(() => expect(screen.queryByText(EDIT_NOTICE)).toBeNull())
  })
})
