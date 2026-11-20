// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EVENT_ONLY_SCHEDULE,
  type AutomationEventTrigger
} from '../../../../../shared/automation-event-triggers'
import type { Automation } from '../../../../../shared/automations/automation-definition'
import type { AutomationRun } from '../../../../../shared/automations/history/automation-run'
import type { NativeChatMessage } from '../../../../../shared/native-chat/native-chat-types'
import { TooltipProvider } from '@/components/ui/tooltip'
import { makeAutomation, makeRun } from '@/components/automations/automations-page-fixtures'
import { emitAutomationsChangedWindowEvent } from '@/components/automations/events/automations-changed-window-event'
import { NativeChatAutomationSavedRow } from './NativeChatAutomationSavedRow'
import { NativeChatVisualOwnerContext } from '../media/visuals/native-chat-visual-owner'
import {
  NativeChatDisclosureContext,
  useNativeChatDisclosures
} from '../messages/disclosure/native-chat-disclosure-store'

const host = vi.hoisted(() => ({
  openBotAutomation: vi.fn(),
  showAutomationForTarget: vi.fn(),
  listRecentAutomationRunsForTarget: vi.fn(),
  runAutomationNowForTarget: vi.fn(),
  updateAutomationForTarget: vi.fn(),
  requestNativeChatComposerFocus: vi.fn()
}))
vi.mock('@/components/bots/bot-automation-open', () => ({
  openBotAutomation: host.openBotAutomation
}))
vi.mock('@/components/automations/hosts/automation-host-client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  showAutomationForTarget: host.showAutomationForTarget,
  listRecentAutomationRunsForTarget: host.listRecentAutomationRunsForTarget,
  runAutomationNowForTarget: host.runAutomationNowForTarget,
  updateAutomationForTarget: host.updateAutomationForTarget
}))
vi.mock('../composer/focus/native-chat-composer-focus-intent', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  requestNativeChatComposerFocus: host.requestNativeChatComposerFocus
}))

type Saved = NonNullable<NativeChatMessage['automationSaved']>

const SLACK_TRIGGER: AutomationEventTrigger = {
  id: 't1',
  source: 'slack',
  event: 'message',
  in: ['slack:T1:C1'],
  names: { 'slack:T1:C1': '#help' }
}

const saved = (id: string, name: string): Saved => ({
  change: 'created',
  automation: {
    id,
    name,
    enabled: true,
    nextRunAt: 0,
    updatedAt: 1_000,
    ...EVENT_ONLY_SCHEDULE,
    workspaceId: null,
    on: [SLACK_TRIGGER],
    bot: { botId: 'bot-1' }
  },
  resultsTo: 'chat'
})

const full = (id: string, name: string, enabled = true): Automation =>
  makeAutomation({
    id,
    name,
    enabled,
    prompt: 'Read the message, label it, reply in thread.',
    agentId: 'claude',
    ...EVENT_ONLY_SCHEDULE,
    on: [SLACK_TRIGGER],
    bot: { botId: 'bot-1', runsIn: 'new', resultsTo: 'chat' }
  })

// Run times are only listed, never asserted, so a fixed clock is enough.
const NOW = Date.parse('2026-11-02T12:00:00Z')
const run = (id: string, title: string, minutesAgo: number): AutomationRun =>
  makeRun({ id, title, createdAt: NOW - minutesAgo * 60_000 })

const OWNER = {
  target: { kind: 'local' },
  sessionId: 's1',
  worktreeId: 'folder:fw-1',
  tabId: 'tab-1'
} as const

function Chat({ cards }: { cards: Saved[] }): React.JSX.Element {
  const disclosures = useNativeChatDisclosures()
  return (
    <TooltipProvider>
      <NativeChatVisualOwnerContext.Provider value={OWNER}>
        <NativeChatDisclosureContext.Provider value={disclosures}>
          {cards.map((card) => (
            <NativeChatAutomationSavedRow
              key={card.automation.id}
              saved={card}
              timestamp={1_000}
              disclosureId={`row-${card.automation.id}`}
            />
          ))}
        </NativeChatDisclosureContext.Provider>
      </NativeChatVisualOwnerContext.Provider>
    </TooltipProvider>
  )
}

const toggleOf = (name: string): HTMLElement =>
  screen.getByRole('button', { name: new RegExp(name) })

beforeEach(() => {
  host.showAutomationForTarget.mockImplementation((_target, id: string) =>
    Promise.resolve(full(id, id === 'auto-1' ? 'Slack triage' : 'Morning digest'))
  )
  host.listRecentAutomationRunsForTarget.mockResolvedValue([
    run('r1', '#help · “login broken”', 2),
    run('r2', '#help · “invite me”', 60)
  ])
  host.runAutomationNowForTarget.mockResolvedValue({})
})

afterEach(() => {
  cleanup()
  for (const fn of Object.values(host)) {
    fn.mockReset()
  }
})

describe('an automation card opened in place', () => {
  it('opens to when it runs, where results go, the agent, recent runs and the prompt', async () => {
    render(<Chat cards={[saved('auto-1', 'Slack triage')]} />)
    const toggle = toggleOf('Slack triage')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(host.showAutomationForTarget).not.toHaveBeenCalled()

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(await screen.findByText('Read the message, label it, reply in thread.')).toBeVisible()
    expect(screen.getByText('On a Slack message · in #help')).toBeVisible()
    expect(screen.getByText('Chat')).toBeVisible()
    expect(screen.getByText('Claude Code')).toBeVisible()
    const runs = screen.getByRole('list', { name: 'Recent runs' })
    expect(within(runs).getByText('#help · “login broken”')).toBeVisible()
    expect(within(runs).getByText('#help · “invite me”')).toBeVisible()
    expect(host.showAutomationForTarget).toHaveBeenCalledWith({ kind: 'local' }, 'auto-1')

    fireEvent.click(within(runs).getByText('#help · “invite me”'))
    expect(host.openBotAutomation).toHaveBeenCalledWith('auto-1', 'r2')
  })

  it('closes on a second click and on Esc', async () => {
    render(<Chat cards={[saved('auto-1', 'Slack triage')]} />)
    const toggle = toggleOf('Slack triage')
    fireEvent.click(toggle)
    await screen.findByText('Read the message, label it, reply in thread.')
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(toggle)
    const runNow = await screen.findByRole('button', { name: 'Run now' })
    fireEvent.keyDown(runNow, { key: 'Escape' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(toggle).toHaveFocus()
  })

  it('keeps one card open at a time per chat', async () => {
    render(<Chat cards={[saved('auto-1', 'Slack triage'), saved('auto-2', 'Morning digest')]} />)
    fireEvent.click(toggleOf('Slack triage'))
    await screen.findByRole('button', { name: 'Run now' })
    fireEvent.click(toggleOf('Morning digest'))
    expect(toggleOf('Slack triage')).toHaveAttribute('aria-expanded', 'false')
    expect(toggleOf('Morning digest')).toHaveAttribute('aria-expanded', 'true')
    expect(await screen.findAllByRole('button', { name: 'Run now' })).toHaveLength(1)
  })

  it('Edit in chat drafts the change into this chat and leaves the card open', async () => {
    render(<Chat cards={[saved('auto-1', 'Slack triage')]} />)
    fireEvent.click(toggleOf('Slack triage'))
    fireEvent.click(await screen.findByRole('button', { name: 'Edit in chat' }))
    expect(host.requestNativeChatComposerFocus).toHaveBeenCalledWith('tab-1', {
      append: 'Change “Slack triage” so that '
    })
    expect(toggleOf('Slack triage')).toHaveAttribute('aria-expanded', 'true')
  })

  it('runs it now, pauses it, and opens the full page', async () => {
    host.updateAutomationForTarget.mockImplementation((automation: Automation) =>
      Promise.resolve(full(automation.id, automation.name, false))
    )
    render(<Chat cards={[saved('auto-1', 'Slack triage')]} />)
    fireEvent.click(toggleOf('Slack triage'))
    fireEvent.click(await screen.findByRole('button', { name: 'Run now' }))
    await vi.waitFor(() => expect(host.runAutomationNowForTarget).toHaveBeenCalledTimes(1))
    // The run re-reads the card, so its new run shows.
    await vi.waitFor(() => expect(host.listRecentAutomationRunsForTarget).toHaveBeenCalledTimes(2))
    await act(async () => {})

    fireEvent.click(screen.getByRole('switch', { name: 'Pause Slack triage' }))
    expect(await screen.findByRole('switch', { name: 'Resume Slack triage' })).not.toBeChecked()
    expect(host.updateAutomationForTarget).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'auto-1' }),
      { enabled: false },
      { kind: 'local' }
    )

    fireEvent.click(screen.getByRole('button', { name: 'Open full page' }))
    expect(host.openBotAutomation).toHaveBeenCalledWith('auto-1', null)
  })

  it('says a deleted automation was deleted', async () => {
    host.showAutomationForTarget.mockRejectedValue(new Error('Automation not found.'))
    render(<Chat cards={[saved('auto-1', 'Slack triage')]} />)
    fireEvent.click(toggleOf('Slack triage'))
    expect(await screen.findByText('This automation was deleted')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Run now' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Open full page' })).toBeNull()
  })

  it('re-reads when automations change, and not while closed', async () => {
    render(<Chat cards={[saved('auto-1', 'Slack triage')]} />)
    act(() => emitAutomationsChangedWindowEvent())
    expect(host.showAutomationForTarget).not.toHaveBeenCalled()
    fireEvent.click(toggleOf('Slack triage'))
    await screen.findByRole('button', { name: 'Run now' })
    act(() => emitAutomationsChangedWindowEvent())
    expect(host.showAutomationForTarget).toHaveBeenCalledTimes(2)
  })
})
