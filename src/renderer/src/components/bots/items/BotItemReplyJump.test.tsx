// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotItem, BotItemEvent } from '../../../../../shared/bots/bot-items'
import { makeTestBotItem } from '../../../../../shared/bots/bot-item.test-fixture'
import type { BotItemViewRead } from './use-bot-item-view'

vi.mock('./use-bot-items', () => ({
  commentOnBotItem: vi.fn(() => Promise.resolve()),
  setBotItemsStatus: vi.fn(),
  answerBotItem: vi.fn()
}))
vi.mock('../BotGroupTranscriptOwner', () => ({ useBotGroupFileContexts: () => new Map() }))

import { TooltipProvider } from '@/components/ui/tooltip'
import { BotItemBody } from './BotItemView'

const BOT: Bot = {
  id: 'bot-a',
  name: 'Release bot',
  hostId: 'local',
  folder: 'release-bot',
  folderWorkspaceId: 'w1',
  agent: 'codex',
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
const ACTOR = { kind: 'bot' as const, botId: 'bot-a', chatId: 'chat-home' }
const EVENTS: BotItemEvent[] = [
  { id: 'e1', kind: 'made', actor: ACTOR, data: { status: 'working' }, at: 1 },
  {
    id: 'e2',
    kind: 'status',
    actor: ACTOR,
    data: { from: 'working', to: 'needs_you', note: 'View-only or editable?' },
    at: 2
  },
  { id: 'e3', kind: 'commented', actor: ACTOR, data: { text: 'Checks are green.' }, at: 3 }
]

/** Each observer the page made, with the edge it watches. */
let observers: FakeIntersectionObserver[] = []

class FakeIntersectionObserver implements IntersectionObserver {
  readonly root: Element | Document | null
  readonly rootMargin: string
  readonly scrollMargin = '0px'
  readonly thresholds: readonly number[] = [0, 1]
  constructor(
    private readonly callback: IntersectionObserverCallback,
    options: IntersectionObserverInit | undefined
  ) {
    this.root = options?.root ?? null
    this.rootMargin = options?.rootMargin ?? ''
    observers.push(this)
  }
  fire(isIntersecting: boolean, intersectionRatio: number): void {
    const box = new DOMRect()
    this.callback(
      [
        {
          boundingClientRect: box,
          intersectionRect: box,
          rootBounds: box,
          target: document.body,
          time: 0,
          isIntersecting,
          intersectionRatio
        }
      ],
      this
    )
  }
  observe(): void {}
  unobserve(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return []
  }
  disconnect(): void {
    observers = observers.filter((observer) => observer !== this)
  }
}

/** The entry that asked moves: in view, or off screen below or above. */
function entryIs(place: 'visible' | 'below' | 'above'): void {
  act(() => {
    for (const observer of observers) {
      // The view's own edge is pulled in by the header; the side's edge reaches far above.
      const showsEdge = observer.rootMargin.startsWith('-')
      if (showsEdge) {
        observer.fire(place === 'visible', place === 'visible' ? 1 : 0)
      } else {
        observer.fire(place !== 'below', place !== 'below' ? 1 : 0)
      }
    }
  })
}

function view(item: BotItem, more: Partial<BotItemViewRead> = {}): BotItemViewRead {
  return {
    item,
    events: EVENTS,
    eventsRead: true,
    hasEarlier: false,
    failed: false,
    deleted: false,
    loadEarlier: vi.fn(),
    retry: vi.fn(),
    ...more
  }
}

function show(item: BotItem, more: Partial<BotItemViewRead> = {}) {
  const read = view(item, more)
  const shown = render(<BotItemBody bot={BOT} item={item} view={read} />, {
    wrapper: TooltipProvider
  })
  return {
    read,
    rerender: (next: BotItem, nextView = more) =>
      shown.rerender(<BotItemBody bot={BOT} item={next} view={view(next, nextView)} />)
  }
}

const reply = () => screen.queryByRole('button', { name: /^Reply/ })

beforeEach(() => {
  observers = []
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it('offers Reply only while the item needs the owner and the entry that asked is off screen', () => {
  const needsYou = makeTestBotItem(6, { status: 'needs_you' })
  const shown = show(needsYou)

  entryIs('below')
  expect(reply()?.getAttribute('aria-label')).toBe('Reply, below')

  entryIs('visible')
  expect(reply()).toBeNull()

  entryIs('above')
  expect(reply()?.getAttribute('aria-label')).toBe('Reply, above')

  shown.rerender({ ...needsYou, status: 'working' })
  entryIs('below')
  expect(reply()).toBeNull()
})

it('puts the cursor in the comment box, naming the entry, when Reply is clicked', () => {
  show(makeTestBotItem(6, { status: 'needs_you' }))
  entryIs('below')

  fireEvent.click(reply()!)

  const box = screen.getByRole('textbox', { name: 'Comment' })
  expect(document.activeElement).toBe(box)
  expect(
    document.getElementById(box.getAttribute('aria-describedby') ?? '')?.textContent
  ).toContain('View-only or editable?')
})

it('finishes a pending Reply when the earlier question loads', () => {
  const asked = makeTestBotItem(6, {
    status: 'needs_you',
    question: { eventId: 'e0', text: 'View-only or editable?' }
  })
  const shown = show(asked, { hasEarlier: true })

  fireEvent.click(screen.getByRole('button', { name: 'Reply, above' }))

  shown.rerender(asked, {
    events: [
      {
        id: 'e0',
        kind: 'commented',
        actor: ACTOR,
        data: { text: 'View-only or editable?' },
        at: 0
      },
      ...EVENTS
    ]
  })

  expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Comment' }))
})
