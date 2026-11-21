// @vitest-environment happy-dom

import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_CATALOG } from '@/lib/agent-catalog/agent-catalog'
import type { AutomationEventTrigger } from '../../../../../shared/automation-event-triggers'
import { EVENT_ONLY_SCHEDULE } from '../../../../../shared/automation-event-triggers'
import type { Bot } from '../../../../../shared/bot-types'
import type { AutomationDraft } from './AutomationEditorDialog'
import { AutomationEditorSettingsSidebar } from './AutomationEditorSettingsSidebar'
import { AutomationSchedulePicker } from './AutomationSchedulePicker'
import { buildAutomationEditDraft } from './automation-edit-draft'
import { botSchedulePatch } from '../../../../../shared/automations/bot-automation-target-edit'
import { makeAutomation } from '../automations-page-fixtures'
import { AUTOMATION_DEFAULT_TIME } from './automation-draft-model'

const openBotHomeTab = vi.hoisted(() => vi.fn(async () => true))
vi.mock('@/lib/bot-catalog', () => ({ openBotHomeTab, useBotThreadReplies: () => true }))
vi.mock('./AutomationBotAgentField', () => ({ AutomationBotAgentField: () => null }))

// A native select, so menu items can be chosen without Radix's portal.
vi.mock('@/components/ui/select', () => ({
  Select: ({
    value,
    onValueChange,
    children
  }: {
    value: string
    onValueChange: (value: string) => void
    children: React.ReactNode
  }) => (
    <select
      aria-label="when"
      value={value}
      onChange={(event) => onValueChange(event.currentTarget.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  )
}))

const MENTIONED: AutomationEventTrigger = {
  id: 'on-1',
  source: 'slack',
  event: 'mentioned',
  in: ['C1', 'C2'],
  textContains: 'deploy'
}

const BOT: Bot = {
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

const EVENT_AUTOMATION = makeAutomation({
  name: 'Deploy pings',
  bot: { botId: 'bot-1', runsIn: 'new', resultsTo: 'chat' },
  projectId: '',
  on: [MENTIONED],
  ...EVENT_ONLY_SCHEDULE
})

function renderSidebar(draft: AutomationDraft, onClose = vi.fn()) {
  const onDraftChange = vi.fn<(updater: (d: AutomationDraft) => AutomationDraft) => void>()
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
      bots={[BOT]}
      surface="terminal"
      chatSupported={null}
      isEditing
      onClose={onClose}
    />
  )
  return { onDraftChange, onClose }
}

afterEach(() => {
  cleanup()
  openBotHomeTab.mockClear()
})

describe("a bot automation's events in the editor", () => {
  it('reads an events-only automation as no schedule, keeping its events', () => {
    const draft = buildAutomationEditDraft(EVENT_AUTOMATION)
    expect(draft).toMatchObject({
      eventsOnly: true,
      savedBotAutomation: { name: 'Deploy pings', botId: 'bot-1', on: [MENTIONED] },
      scheduleWarning: null
    })
    expect(buildAutomationEditDraft(makeAutomation()).eventsOnly).toBe(false)
  })

  it('offers a new automation’s schedule, not its never-reached one, when given a schedule', () => {
    const onDraftChange = vi.fn<(updater: (d: AutomationDraft) => AutomationDraft) => void>()
    const draft = buildAutomationEditDraft(EVENT_AUTOMATION)
    expect(draft).toMatchObject({
      preset: 'weekdays',
      time: AUTOMATION_DEFAULT_TIME,
      customSchedule: '',
      savedSchedule: null
    })
    render(<AutomationSchedulePicker draft={draft} onDraftChange={onDraftChange} />)
    fireEvent.change(screen.getByLabelText('when'), { target: { value: 'custom' } })
    expect(onDraftChange.mock.calls.at(-1)![0](draft).customSchedule).not.toBe('0 0 * * *')
  })

  it('says it never runs once its every event is gone', () => {
    const draft = buildAutomationEditDraft({ ...EVENT_AUTOMATION, on: [] })
    render(<AutomationSchedulePicker draft={draft} onDraftChange={vi.fn()} />)
    expect(screen.getByLabelText<HTMLSelectElement>('when').value).toBe('none')
    expect(screen.getByText('Never')).toBeTruthy()
  })

  it('opens the bot’s chat from the When menu to set up an event', () => {
    renderSidebar(buildAutomationEditDraft(EVENT_AUTOMATION))

    const whenMenu = screen
      .getAllByLabelText('when')
      .find((menu) => menu.querySelector('option[value="events"]'))
    fireEvent.change(whenMenu!, { target: { value: 'events' } })

    expect(openBotHomeTab).toHaveBeenCalledWith(BOT, {
      draft: 'Change the automation “Deploy pings” so it also runs when '
    })
  })

  it('switches between only events and a schedule', () => {
    const onDraftChange = vi.fn<(updater: (d: AutomationDraft) => AutomationDraft) => void>()
    const draft = buildAutomationEditDraft(EVENT_AUTOMATION)
    render(
      <AutomationSchedulePicker
        draft={draft}
        onDraftChange={onDraftChange}
        onSetUpEvents={vi.fn()}
      />
    )
    expect(screen.getByText('Only on events')).toBeTruthy()
    // No time to pick while it runs only on events.
    expect(screen.queryByText('Time')).toBeNull()

    fireEvent.change(screen.getByLabelText('when'), { target: { value: 'daily' } })
    expect(onDraftChange.mock.calls.at(-1)![0](draft)).toMatchObject({
      eventsOnly: false,
      preset: 'daily'
    })
  })

  it('saves "Only on events" as no schedule, and a picked schedule as new', () => {
    const daily = { rrule: 'FREQ=DAILY;BYHOUR=0;BYMINUTE=0', dtstart: 5 }
    const scheduled = makeAutomation({ rrule: daily.rrule, on: [MENTIONED] })
    // Unchanged either way: nothing is sent.
    expect(botSchedulePatch(true, EVENT_AUTOMATION, daily)).toEqual({})
    expect(botSchedulePatch(false, scheduled, daily)).toEqual({})
    // A scheduled automation switched to only events stops its schedule.
    expect(botSchedulePatch(true, scheduled, daily)).toEqual(EVENT_ONLY_SCHEDULE)
    // A schedule picked for an events-only one is sent even if its rule matches the stored one.
    expect(botSchedulePatch(false, EVENT_AUTOMATION, daily)).toEqual(daily)
    expect(botSchedulePatch(false, scheduled, { ...daily, rrule: 'FREQ=HOURLY' })).toEqual({
      ...daily,
      rrule: 'FREQ=HOURLY'
    })
  })

  it('names the saved automation in the chat, not an unsaved rename, and hides Edit in chat without its bot', () => {
    const draft = { ...buildAutomationEditDraft(EVENT_AUTOMATION), name: 'Renamed' }
    const { onClose } = renderSidebar(draft)
    fireEvent.click(screen.getByText('Edit in chat'))
    expect(openBotHomeTab).toHaveBeenCalledWith(BOT, {
      draft: 'Change the automation “Deploy pings”: '
    })
    expect(onClose).toHaveBeenCalled()
    cleanup()

    renderSidebar({
      ...draft,
      savedBotAutomation: { name: 'Deploy pings', botId: 'gone', on: [MENTIONED] }
    })
    expect(
      screen.getByText('When you’re mentioned in Slack · in 2 Slack channels · containing “deploy”')
    ).toBeTruthy()
    expect(screen.queryByText('Edit in chat')).toBeNull()
  })
})
