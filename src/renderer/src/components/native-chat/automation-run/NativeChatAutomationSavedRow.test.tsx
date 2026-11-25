// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  EVENT_ONLY_SCHEDULE,
  type AutomationEventTrigger
} from '../../../../../shared/automation-event-triggers'
import type { NativeChatMessage } from '../../../../../shared/native-chat/native-chat-types'
import { TooltipProvider } from '@/components/ui/tooltip'
import { NativeChatToolRunWindowContext } from '../tools/runs/native-chat-tool-run-window-context'
import {
  NativeChatVisualOwnerContext,
  type NativeChatVisualOwner
} from '../media/visuals/native-chat-visual-owner'
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

const OWNER: NativeChatVisualOwner = {
  target: { kind: 'local' },
  sessionId: 's1',
  worktreeId: 'folder:fw-1'
}

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

// Chat Find with and without a query, as the transcript provides it.
const FINDING = { isVisible: true, findActive: true }
const NOT_FINDING = { isVisible: true, findActive: false }

function render(saved: Saved, findActive = false): void {
  act(() =>
    root.render(
      <TooltipProvider>
        <NativeChatToolRunWindowContext.Provider value={findActive ? FINDING : NOT_FINDING}>
          <NativeChatVisualOwnerContext.Provider value={OWNER}>
            <NativeChatAutomationSavedRow
              saved={saved}
              timestamp={0}
              disclosureId={saved.automation.id}
            />
          </NativeChatVisualOwnerContext.Provider>
        </NativeChatToolRunWindowContext.Provider>
      </TooltipProvider>
    )
  )
}

const toggle = (): HTMLButtonElement | null => container.querySelector('button[aria-expanded]')
const openButton = (): HTMLButtonElement | null =>
  container.querySelector('button[aria-label^="Open "]')
const footerOpen = (): HTMLButtonElement | undefined =>
  [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Open automation'
  )
const automationReads = (): string[] => calls.filter((method) => method.startsWith('automation'))
const details = (): HTMLElement | null => {
  const id = toggle()?.getAttribute('aria-controls')
  return id ? document.getElementById(id) : null
}

it('folds to a heading, the name, one Saved line and Open, without reading the host', () => {
  render(daily)
  const text = container.textContent ?? ''
  expect(text).toContain('Created automation')
  expect(text).toContain('Morning digest')
  expect(text).toMatch(/Saved: \S/)
  expect(toggle()?.getAttribute('aria-expanded')).toBe('false')
  expect(toggle()?.hasAttribute('aria-controls')).toBe(false)
  expect(openButton()?.textContent).toBe('Open')
  expect(footerOpen()).toBeUndefined()
  // The workspace's bot lookup was already there; no automation or run is read folded.
  expect(automationReads()).toEqual([])
})

it('names Open by its automation and opens it as before', () => {
  render(daily)
  expect(openButton()?.getAttribute('aria-label')).toBe('Open Morning digest')
  act(() => openButton()!.click())
  expect(opened).toEqual([['local', 'auto-digest', null]])
  expect(toggle()?.getAttribute('aria-expanded')).toBe('false')
})

it('words an updated event automation by its trigger, and a paused one as paused', () => {
  render(slack)
  expect(container.textContent).toContain('Updated automation')
  expect(container.textContent).toContain('Saved: On a Slack message')
  expect(container.textContent).not.toContain('paused')

  render({ ...daily, automation: { ...daily.automation, enabled: false } })
  expect(container.textContent).toMatch(/Saved: .+· paused/)
})

it('cuts a long trigger before the paused state, never the state itself', () => {
  const rooms = Array.from({ length: 12 }, (_, index) => `slack:T1:C${index}`)
  render({
    ...slack,
    automation: {
      ...slack.automation,
      enabled: false,
      on: rooms.map((room, index): AutomationEventTrigger => ({
        id: `on-${index}`,
        source: 'slack',
        event: 'message',
        in: [room],
        names: { [room]: `#incident-response-channel-number-${index}` }
      }))
    }
  })
  const trigger = container.querySelector('[data-saved-when]')
  const state = container.querySelector('[data-saved-paused]')
  expect(trigger?.className).toContain('line-clamp-2')
  expect(state?.textContent).toBe('· paused')
  // The state is outside the clamped text and never shrinks, so the clamp cannot hide it.
  expect(trigger?.contains(state ?? null)).toBe(false)
  expect(state?.className).toContain('shrink-0')
  expect(toggle()?.getAttribute('aria-label')).toContain('paused')
})

it('lets the whole header open Details and points the toggle at them', () => {
  render(daily)
  const button = toggle()!
  // The toggle lies over the header; the avatar, heading, time and words let clicks fall to it.
  expect(button.className).toContain('absolute')
  const header = button.parentElement!
  for (const text of ['Created automation', 'Morning digest']) {
    const node = [...header.querySelectorAll('span')].find((span) => span.textContent === text)
    expect(node?.closest('.pointer-events-none')).not.toBeNull()
  }
  expect(openButton()?.className).toContain('pointer-events-auto')
  expect(button.getAttribute('aria-label')).toMatch(/^Created automation, Morning digest, Saved: /)

  act(() => button.click())
  expect(button.getAttribute('aria-expanded')).toBe('true')
  expect(details()).not.toBeNull()
  expect(details()?.textContent).toContain('results to Chat')
  // Details read the automation and its runs only once opened.
  expect(automationReads().length).toBeGreaterThan(0)
})

it('keeps Open automation at the end of opened Details, then Escape returns to the toggle', () => {
  render(daily)
  act(() => toggle()!.click())
  const link = footerOpen()
  expect(link).toBeDefined()
  expect(details()?.contains(link ?? null)).toBe(true)
  // Keyboard order: toggle, Open, the Details' own controls, then Open automation last.
  const buttons = [...container.querySelectorAll('button')]
  expect(buttons[0]).toBe(toggle())
  expect(buttons[1]).toBe(openButton())
  expect(buttons.at(-1)).toBe(link)
  act(() => link!.click())
  expect(opened).toEqual([['local', 'auto-digest', null]])

  link!.focus()
  act(() => {
    link!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  expect(toggle()?.getAttribute('aria-expanded')).toBe('false')
  expect(details()).toBeNull()
  expect(document.activeElement).toBe(toggle())
})

it('wraps long saved facts in opened Details instead of cutting them', () => {
  const room = 'slack:T1:C1'
  const place = `#${'x'.repeat(180)}`
  render({
    ...slack,
    automation: {
      ...slack.automation,
      on: [{ id: 'on-1', source: 'slack', event: 'message', in: [room], names: { [room]: place } }]
    }
  })
  act(() => toggle()!.click())
  const facts = [...(details()?.querySelectorAll('p') ?? [])].find((node) =>
    node.textContent?.includes(place)
  )
  expect(facts).toBeDefined()
  expect(facts?.closest('[class*="overflow-wrap:anywhere"]')).not.toBeNull()
  expect(details()?.closest('[class*="overflow-hidden"]')).toBeNull()
})

it('draws the folded facts whole for Find without opening the live Details', () => {
  render(daily, true)
  expect(toggle()?.getAttribute('aria-expanded')).toBe('true')
  expect(details()?.textContent).toContain('results to Chat')
  expect(container.querySelector('[data-saved-when]')?.className).not.toContain('line-clamp')
  expect(automationReads()).toEqual([])

  // Clearing the query folds the card back as it was.
  render(daily, false)
  expect(toggle()?.getAttribute('aria-expanded')).toBe('false')
  expect(details()).toBeNull()
  expect(container.textContent).not.toContain('results to Chat')
  expect(container.querySelector('[data-saved-when]')?.className).toContain('line-clamp-2')
  expect(automationReads()).toEqual([])
})
