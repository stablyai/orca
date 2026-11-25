// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EVENT_ONLY_SCHEDULE } from '../../../../../shared/automation-event-triggers'
import type { NativeChatMessage } from '../../../../../shared/native-chat/native-chat-types'
import { TooltipProvider } from '@/components/ui/tooltip'
import { NativeChatVisualOwnerContext } from '../media/visuals/native-chat-visual-owner'
import { NativeChatAutomationSavedRow } from './NativeChatAutomationSavedRow'

const opened = vi.hoisted((): unknown[][] => [])
vi.mock('@/components/bots/bot-automation-open', () => ({
  openBotAutomation: (...args: unknown[]) => {
    opened.push(args)
  }
}))

type Saved = NonNullable<NativeChatMessage['automationSaved']>

const calls: string[] = []
let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  calls.length = 0
  opened.length = 0
  vi.stubGlobal('api', {
    ...window.api,
    runtime: {
      ...window.api?.runtime,
      // Never answers: the folded card must not ask, and Details' own reads are not under test.
      call: ({ method }: { method: string }) => {
        calls.push(method)
        return new Promise(() => {})
      }
    }
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const OWNER = { target: { kind: 'local' }, sessionId: 's1', worktreeId: 'folder:fw-1' } as const

const daily: Saved = {
  change: 'created',
  resultsTo: 'chat',
  automation: {
    id: 'auto-digest',
    name: 'Morning digest',
    enabled: true,
    nextRunAt: 0,
    updatedAt: 0,
    dtstart: 0,
    rrule: 'FREQ=DAILY;BYHOUR=8;BYMINUTE=30',
    workspaceId: null,
    bot: { botId: 'bot-1' }
  }
}

const slack: Saved = {
  change: 'updated',
  resultsTo: 'chat',
  automation: {
    ...daily.automation,
    id: 'auto-triage',
    name: 'Slack triage',
    ...EVENT_ONLY_SCHEDULE,
    on: [
      {
        id: 'on-1',
        source: 'slack',
        event: 'message',
        in: ['slack:T1:C1'],
        names: { 'slack:T1:C1': '#help' }
      }
    ]
  }
}

function render(saved: Saved): void {
  act(() =>
    root.render(
      <TooltipProvider>
        <NativeChatVisualOwnerContext.Provider value={OWNER}>
          <NativeChatAutomationSavedRow
            saved={saved}
            timestamp={0}
            disclosureId={saved.automation.id}
          />
        </NativeChatVisualOwnerContext.Provider>
      </TooltipProvider>
    )
  )
}

const toggle = (): HTMLButtonElement | null => container.querySelector('button[aria-expanded]')
const openButton = (): HTMLButtonElement | null =>
  container.querySelector('button[aria-label="Open automation"]')

it('folds to a heading, the name, one Saved line and Open, without reading the host', () => {
  render(daily)
  const text = container.textContent ?? ''
  expect(text).toContain('Created automation')
  expect(text).toContain('Morning digest')
  expect(text).toMatch(/Saved: \S/)
  expect(toggle()?.getAttribute('aria-expanded')).toBe('false')
  expect(openButton()?.textContent).toBe('Open')
  // The workspace's bot lookup was already there; no automation or run is read folded.
  expect(calls.filter((method) => method.startsWith('automation'))).toEqual([])
})

it('words an updated event automation by its trigger, and a paused one as paused', () => {
  render(slack)
  expect(container.textContent).toContain('Updated automation')
  expect(container.textContent).toContain('Saved: On a Slack message')
  expect(container.textContent).not.toContain('paused')

  render({ ...daily, automation: { ...daily.automation, enabled: false } })
  expect(container.textContent).toMatch(/Saved: .+ · paused/)
})

it('opens the automation from the folded card, as before', () => {
  render(daily)
  act(() => openButton()!.click())
  expect(opened).toEqual([['local', 'auto-digest', null]])
  expect(toggle()?.getAttribute('aria-expanded')).toBe('false')
})

it('discloses Details on the toggle and closes them with Escape', () => {
  render(daily)
  act(() => toggle()!.click())
  expect(toggle()?.getAttribute('aria-expanded')).toBe('true')
  // Details read the automation and its runs only once opened.
  expect(calls.some((method) => method.startsWith('automation'))).toBe(true)
  expect(openButton()).not.toBeNull()

  act(() => {
    toggle()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  expect(toggle()?.getAttribute('aria-expanded')).toBe('false')
  expect(document.activeElement).toBe(toggle())
})
