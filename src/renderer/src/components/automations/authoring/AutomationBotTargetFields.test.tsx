// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_CATALOG } from '@/lib/agent-catalog/agent-catalog'
import type { AutomationBotTarget } from '../../../../../shared/automations/automation-definition'
import type { Bot } from '../../../../../shared/bot-types'
import type { AutomationDraft } from './AutomationEditorDialog'
import { AutomationEditorSettingsSidebar } from './AutomationEditorSettingsSidebar'
import { buildAutomationEditDraft } from './automation-edit-draft'
import { botTargetError, isSameBotTarget } from './automation-bot-save'
import { botResultsPlace, withBotResultsPlace } from './automation-bot-results-to'
import { makeAutomation } from '../automations-page-fixtures'

vi.mock('./AutomationSchedulePicker', () => ({ AutomationSchedulePicker: () => null }))
vi.mock('./AutomationWorkspaceField', () => ({
  AutomationWorkspaceField: () => <div>workspace-field</div>
}))
vi.mock('./AutomationSessionField', () => ({
  AutomationSessionField: () => <div>session-field</div>
}))
vi.mock('./AutomationMissedRunGraceField', () => ({ AutomationMissedRunGraceField: () => null }))
vi.mock('./AutomationPrecheckFields', () => ({ AutomationPrecheckFields: () => null }))
vi.mock('./AutomationSetupDecisionField', () => ({ AutomationSetupDecisionField: () => null }))
vi.mock('./AutomationExtraAgentArgsField', () => ({ AutomationExtraAgentArgsField: () => null }))
vi.mock('./AutomationBotAgentField', () => ({
  AutomationBotAgentField: () => <div>bot-agent-field</div>
}))

const BOTS: Bot[] = [
  {
    id: 'bot-1',
    name: 'Reviewer',
    hostId: 'local',
    folder: 'reviewer',
    folderWorkspaceId: 'w1',
    agent: 'claude',
    avatar: null,
    paused: false,
    permissionMode: 'ask',
    notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
    members: [],
    slack: null,
    chatSessionId: null,
    linear: null,
    github: null,
    createdAt: 1,
    updatedAt: 1
  }
]
BOTS.push({ ...BOTS[0]!, id: 'bot-2', name: 'Scout', folder: 'scout', folderWorkspaceId: 'w2' })
const TARGET: AutomationBotTarget = { botId: 'bot-1', runsIn: 'new', resultsTo: 'chat' }

const DRAFT: AutomationDraft = {
  name: '',
  prompt: '',
  agentId: 'codex',
  extraAgentArgs: '--flag',
  bot: null,
  projectId: 'repo-1',
  workspaceMode: 'existing',
  workspaceId: 'repo-1::/w',
  baseBranch: '',
  reuseSession: true,
  precheckCommand: '',
  precheckTimeoutSeconds: '60',
  preset: 'weekdays',
  time: '09:00',
  dayOfWeek: '1',
  customSchedule: '',
  missedRunGraceMinutes: '720',
  savedSchedule: null,
  scheduleWarning: null
}

function renderSidebar(
  draft: AutomationDraft,
  onDraftChange = vi.fn<(updater: (d: AutomationDraft) => AutomationDraft) => void>(),
  isEditing = false
) {
  render(
    <AutomationEditorSettingsSidebar
      repos={[]}
      projectHostSetups={[]}
      automationYamlHooksByRepoKey={{}}
      getAutomationHooksCacheKey={(repoId) => repoId}
      repoMap={new Map()}
      worktrees={[]}
      settings={null}
      draft={draft}
      visibleAgents={AGENT_CATALOG}
      pickerTriggerClassName=""
      onProjectChange={vi.fn()}
      onDraftChange={onDraftChange}
      onSetupDecisionTouched={vi.fn()}
      bots={BOTS}
      surface="terminal"
      chatSupported={null}
      isEditing={isEditing}
      onClose={vi.fn()}
    />
  )
  return onDraftChange
}

afterEach(cleanup)

describe('automation bot target', () => {
  it("shows only When, Runs in, the bot's agent and Send results to for a bot", () => {
    renderSidebar({ ...DRAFT, bot: TARGET })

    expect(screen.getByText('When')).toBeTruthy()
    expect(screen.getByText('Runs in')).toBeTruthy()
    expect(screen.getByText('Send results to')).toBeTruthy()
    expect(screen.getByText('Bot · Reviewer')).toBeTruthy()
    expect(screen.getByText('bot-agent-field')).toBeTruthy()
    expect(screen.queryByText('Agent')).toBeNull()
    expect(screen.queryByText('workspace-field')).toBeNull()
    expect(screen.queryByText('session-field')).toBeNull()
  })

  it('keeps the project fields for a project target', () => {
    renderSidebar(DRAFT)

    expect(screen.getByText('Agent')).toBeTruthy()
    expect(screen.getByText('workspace-field')).toBeTruthy()
    expect(screen.queryByText('Runs in')).toBeNull()
  })

  it("choosing a bot takes the bot's agent and drops the project's settings", () => {
    const onDraftChange = renderSidebar(DRAFT)

    fireEvent.click(screen.getByText('Select bot or project'))
    fireEvent.click(screen.getByText('Bot · Reviewer'))

    const next = onDraftChange.mock.calls.at(-1)![0](DRAFT)
    expect(next).toMatchObject({
      bot: TARGET,
      agentId: 'claude',
      extraAgentArgs: '',
      projectId: '',
      workspaceId: '',
      reuseSession: false
    })
  })

  it('keeps Let react when the automation moves to another bot', () => {
    const reacting = { ...DRAFT, bot: { ...TARGET, letBotReact: true } }
    const onDraftChange = renderSidebar(reacting)

    fireEvent.click(screen.getByText('Bot · Reviewer'))
    fireEvent.click(screen.getByText('Bot · Scout'))

    const next = onDraftChange.mock.calls.at(-1)![0](reacting)
    expect(next.bot).toEqual({ ...TARGET, botId: 'bot-2', letBotReact: true })
  })

  it('offers no projects while editing a bot automation', () => {
    renderSidebar({ ...DRAFT, bot: TARGET }, undefined, true)

    fireEvent.click(screen.getAllByRole('combobox')[0])

    expect(screen.queryByText('Add project')).toBeNull()
  })

  it('round-trips the bot target through an edit draft', () => {
    const automation = makeAutomation({
      bot: { ...TARGET, runsIn: 'chat', resultsTo: { channel: '#eng' } },
      projectId: ''
    })

    expect(buildAutomationEditDraft(automation).bot).toEqual(automation.bot)
  })

  it('needs a channel name before saving results to a channel', () => {
    expect(botTargetError({ ...TARGET, resultsTo: { channel: ' ' } })).toMatch(/channel/)
    expect(botTargetError({ ...TARGET, resultsTo: { channel: '#eng' } })).toBeNull()
    expect(botTargetError(TARGET)).toBeNull()
  })

  it('needs a Linear issue before saving results to one; the host looks it up', () => {
    expect(botTargetError({ ...TARGET, resultsTo: { linearIssue: ' ' } })).toMatch(/ENG-123/)
    expect(botTargetError({ ...TARGET, resultsTo: { linearIssue: 'ENG-123' } })).toBeNull()
    expect(
      botTargetError({
        ...TARGET,
        resultsTo: { linearIssue: 'https://linear.app/acme/issue/ENG-123' }
      })
    ).toBeNull()
  })

  it('shows a saved ref by its label, and keeps the ref while the label is unchanged', () => {
    const saved = { linearIssue: 'linear:org-1:issue-7', label: 'ENG-7 Flaky login' }
    expect(botResultsPlace(saved)).toBe('ENG-7 Flaky login')
    expect(withBotResultsPlace(saved, 'ENG-7 Flaky login')).toBe(saved)
    expect(withBotResultsPlace(saved, 'ENG-8')).toEqual({ linearIssue: 'ENG-8' })
  })

  it('offers Let react, off, only when a new conversation sends results to the Chat', () => {
    const onDraftChange = renderSidebar({ ...DRAFT, bot: TARGET })

    const toggle = screen.getByRole('switch', { name: 'Let Reviewer react' })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(screen.getByText('Each result starts a turn so Reviewer can act on it.')).toBeTruthy()
    fireEvent.click(toggle)

    const next = onDraftChange.mock.calls.at(-1)![0]({ ...DRAFT, bot: TARGET })
    expect(next.bot).toEqual({ ...TARGET, letBotReact: true })
    cleanup()

    renderSidebar({ ...DRAFT, bot: { ...TARGET, runsIn: 'chat' } })
    expect(screen.queryByRole('switch')).toBeNull()
    cleanup()

    renderSidebar({ ...DRAFT, bot: { ...TARGET, resultsTo: 'none' } })
    expect(screen.queryByRole('switch')).toBeNull()
  })

  it('saves a target whose only change is Let react', () => {
    expect(isSameBotTarget(TARGET, { ...TARGET, letBotReact: false })).toBe(true)
    expect(isSameBotTarget(TARGET, { ...TARGET, letBotReact: true })).toBe(false)
  })

  it("saves a target whose only change is its own agent or model, or going back to the bot's", () => {
    const own: AutomationBotTarget = {
      ...TARGET,
      agentSetup: { agent: 'codex', launch: { model: 'gpt-6.1-terra' } }
    }
    expect(isSameBotTarget(own, { ...own })).toBe(true)
    expect(isSameBotTarget(own, { ...own, agentSetup: { agent: 'codex' } })).toBe(false)
    expect(isSameBotTarget(own, TARGET)).toBe(false)
  })

  it('edits a Linear issue target with its own field', () => {
    const onDraftChange = renderSidebar({
      ...DRAFT,
      bot: { ...TARGET, resultsTo: { linearIssue: 'ENG-1' } }
    })

    expect(screen.getByLabelText('Linear issue').getAttribute('placeholder')).toBe(
      'Issue key (e.g. ENG-123) or a Linear link'
    )
    fireEvent.change(screen.getByLabelText('Linear issue'), { target: { value: 'ENG-42' } })

    const next = onDraftChange.mock.calls.at(-1)![0]({ ...DRAFT, bot: TARGET })
    expect(next.bot?.resultsTo).toEqual({ linearIssue: 'ENG-42' })
  })

  it('asks for a channel or a Slack link, which the host looks up on save', () => {
    renderSidebar({ ...DRAFT, bot: { ...TARGET, resultsTo: { channel: '' } } })
    expect(screen.getByLabelText('Channel').getAttribute('placeholder')).toBe(
      '#channel or a Slack link'
    )
  })
})
