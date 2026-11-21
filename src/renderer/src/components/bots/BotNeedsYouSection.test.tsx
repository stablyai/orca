// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useLayoutEffect, useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StructuredPromptItem } from '../../../../shared/agent-session/view/structured-agent-session-message-projection'

const mocks = vi.hoisted(() => ({
  prompts: new Map<string, unknown>(),
  listeners: new Set<() => void>(),
  respond: vi.fn(),
  openSession: vi.fn(),
  openHome: vi.fn(),
  openAutomation: vi.fn(),
  manageConnectors: vi.fn(),
  reviewAccess: vi.fn(),
  openWorker: vi.fn(),
  awaiting: new Map<string, { itemId: string; text: string }>(),
  skip: vi.fn(() => Promise.resolve()),
  toastError: vi.fn()
}))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))
vi.mock('../native-chat/prompts/use-structured-agent-session-async-question-skip', () => ({
  useStructuredAgentSessionAsyncQuestionSkip: (_target: unknown, sessionId: string) => ({
    skippedThrough: undefined,
    awaiting: mocks.awaiting.get(sessionId),
    save: mocks.skip
  })
}))
vi.mock('./use-bot-session-prompt', async () => {
  const { useSyncExternalStore } = await import('react')
  const subscribe = (listener: () => void): (() => void) => {
    mocks.listeners.add(listener)
    return () => mocks.listeners.delete(listener)
  }
  return {
    useBotSessionPrompt: (_bot: unknown, sessionId: string) => ({
      prompt: useSyncExternalStore(subscribe, () => mocks.prompts.get(sessionId) ?? null),
      respond: mocks.respond,
      holds: () => false
    })
  }
})
vi.mock('./bot-session-open', () => ({ openBotSession: mocks.openSession }))
vi.mock('@/lib/bot-catalog', () => ({ openBotHomeTab: mocks.openHome }))
vi.mock('./bot-automation-open', () => ({ openBotAutomation: mocks.openAutomation }))
vi.mock('./AddConnectorDialog', () => ({ manageConnectors: mocks.manageConnectors }))
vi.mock('@/lib/bot-access-requests', () => ({ reviewAccessRequest: mocks.reviewAccess }))
vi.mock('@/lib/open-orchestration-worker', () => ({
  openOrchestrationWorker: mocks.openWorker,
  revealWorkerPane: vi.fn()
}))
vi.mock('./use-bot-host-label', () => ({ useBotHostLabel: () => null }))
import type { Bot } from '../../../../shared/bot-types'
import type { BotAutomationRow } from '../../../../shared/bots/bot-automation-rows'
import type { BotSessionActivityRow } from '../../../../shared/bots/bot-activity-model'
import type { BotConnectorEntry } from './bot-connector-entries'
import type { BotItem } from '../../../../shared/bots/bot-items'
import { makeTestBotItem } from '../../../../shared/bots/bot-item.test-fixture'
import { BotNeedsYouSection } from './BotNeedsYouSection'
import type { BotNeedView } from './use-bot-now'

/** Items by the Dispatch they link. */
const ITEMS = new Map<string, BotItem>([
  ['d-wake', makeTestBotItem(7, { title: 'Wake the item’s chat when a linked PR merges' })]
])

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the section reads only these fields.
const BOT = { id: 'bot-1', hostId: 'local', name: 'CoS', chatSessionId: 'chat-1' } as Bot

const thread = (sessionId: string, title: string): BotSessionActivityRow => ({
  kind: 'thread',
  key: `thread:${sessionId}`,
  title,
  source: 'slack',
  dot: 'waiting',
  sessionId,
  at: 1
})

function prompt(body: Record<string, unknown>): StructuredPromptItem {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the row reads only the body and passes the item back.
  return { itemId: 'item-1', revision: 3, body } as unknown as StructuredPromptItem
}

function automationRow(id: string, name: string, latestRunId: string): BotAutomationRow {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the rows read only these fields.
  return { key: id, failing: true, latestRunId, automation: { id, name } } as BotAutomationRow
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the row reads only its kind.
const LINEAR = {
  kind: 'linear',
  key: 'linear:w1',
  title: { service: 'Linear', name: null },
  needsOwner: true
} as BotConnectorEntry

/** Earlier in the tree than the card, so its layout effect runs first in a commit. */
function TakesFocus({ when }: { when: boolean }): React.JSX.Element {
  const button = useRef<HTMLButtonElement | null>(null)
  useLayoutEffect(() => {
    if (when) {
      button.current?.focus()
    }
  }, [when])
  return (
    <button ref={button} type="button">
      Outside
    </button>
  )
}

function Card({
  needs,
  stoppedForSignIn,
  offline = false,
  takeFocus = false
}: {
  needs: BotNeedView[]
  stoppedForSignIn: BotAutomationRow[]
  offline?: boolean
  takeFocus?: boolean
}): React.JSX.Element {
  const fallback = useRef<HTMLDivElement | null>(null)
  return (
    <div ref={fallback} tabIndex={-1} data-testid="panel">
      <TakesFocus when={takeFocus} />
      <fieldset disabled={offline}>
        <BotNeedsYouSection
          bot={BOT}
          asks={{ needs, stoppedForSignIn, itemOf: (id) => ITEMS.get(id) ?? null }}
          offline={offline}
          focusFallback={fallback}
        />
      </fieldset>
    </div>
  )
}

function renderNeeds(
  needs: BotNeedView[],
  stoppedForSignIn: BotAutomationRow[] = []
): (next: BotNeedView[], offline?: boolean, takeFocus?: boolean) => void {
  const { rerender } = render(<Card needs={needs} stoppedForSignIn={stoppedForSignIn} />)
  return (next, offline, takeFocus) =>
    rerender(
      <Card
        needs={next}
        stoppedForSignIn={stoppedForSignIn}
        offline={offline}
        takeFocus={takeFocus}
      />
    )
}

const QUESTION = { kind: 'question', question: 'Which branch?', options: [] }
const APPROVAL = {
  kind: 'approval',
  title: 'Bash',
  detail: 'git push',
  options: [
    { id: 'allow', label: 'Allow' },
    { id: 'deny', label: 'Deny' }
  ]
}

/** A thread waiting on the owner with `body` as its prompt; titled `Ask <n>`. */
function asking(n: number, body: Record<string, unknown> = QUESTION): BotNeedView {
  mocks.prompts.set(`t${n}`, prompt(body))
  return { kind: 'session', key: `thread:t${n}`, row: thread(`t${n}`, `Ask ${n}`) }
}

function asks(count: number): BotNeedView[] {
  return Array.from({ length: count }, (_, index) => asking(index + 1))
}

function setPrompt(n: number, body: Record<string, unknown>): void {
  act(() => {
    mocks.prompts.set(`t${n}`, prompt(body))
    for (const listener of mocks.listeners) {
      listener()
    }
  })
}

/** Accessible names of the row actions shown, in order; the footer and the outside button aside. */
function shownActions(): string[] {
  return screen
    .getAllByRole('button')
    .map((button) => button.getAttribute('aria-label') ?? button.textContent ?? '')
    .filter((name) => name !== 'Outside' && !name.startsWith('Show '))
}

function footer(): string | null {
  return screen.queryByRole('button', { name: /^Show / })?.textContent ?? null
}

beforeEach(() => {
  mocks.prompts.clear()
  mocks.awaiting.clear()
  for (const mock of Object.values(mocks)) {
    if (typeof mock === 'function') {
      mock.mockClear()
    }
  }
})
afterEach(() => cleanup())

/** A worker waiting on the owner in its own pane. */
function workerAsk(
  dispatchId: string,
  title: string,
  fields: Partial<Extract<BotSessionActivityRow, { kind: 'worker' }>> = {}
): BotNeedView {
  return {
    kind: 'session',
    key: `worker:${dispatchId}`,
    row: {
      kind: 'worker',
      key: `worker:${dispatchId}`,
      dispatchId,
      title,
      dot: 'permission',
      origin: { kind: 'chat' },
      paneKey: null,
      workspaceId: null,
      at: 1,
      worker: null,
      ...fields
    }
  }
}

describe('Needs you', () => {
  it('opens a chat’s pending approval where it was asked, naming its tool and command', () => {
    mocks.prompts.set('t1', prompt(APPROVAL))
    renderNeeds([{ kind: 'session', key: 'thread:t1', row: thread('t1', 'Fix flaky test') }])

    expect(screen.getByText('git push')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Allow/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open: Fix flaky test' }))
    expect(mocks.openSession).toHaveBeenCalledWith(BOT, 't1')
    expect(mocks.respond).not.toHaveBeenCalled()
  })

  it('shows the question a chat waits on without a prompt, and Skips it by its row', () => {
    mocks.awaiting.set('t3', { itemId: 'ask-row', text: 'File the follow-up?' })
    renderNeeds([{ kind: 'session', key: 'thread:t3', row: thread('t3', 'Review') }])

    expect(screen.getByText('File the follow-up?')).toBeTruthy()
    expect(screen.queryByText('Waiting for you')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Skip: Review' }))
    expect(mocks.skip).toHaveBeenCalledWith('ask-row')
    expect(mocks.openSession).not.toHaveBeenCalled()
  })

  it('tells a Skip the host did not save', async () => {
    mocks.skip.mockRejectedValueOnce(new Error('offline'))
    mocks.awaiting.set('t3', { itemId: 'ask-row', text: 'File the follow-up?' })
    renderNeeds([{ kind: 'session', key: 'thread:t3', row: thread('t3', 'Review') }])

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Skip: Review' }))
    })
    expect(mocks.toastError).toHaveBeenCalledWith('Something went wrong. Try again.')
  })

  it('shows a question and opens its chat; the Home chat opens as Home', () => {
    mocks.prompts.set('t2', prompt({ kind: 'question', question: 'Which branch?', options: [] }))
    mocks.prompts.set('chat-1', prompt({ kind: 'question', question: 'Ship it?', options: [] }))
    renderNeeds([
      { kind: 'session', key: 'thread:t2', row: thread('t2', 'Release') },
      { kind: 'chat', key: 'chat' }
    ])

    expect(screen.getByText('Which branch?')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open: Release' }))
    expect(mocks.openSession).toHaveBeenCalledWith(BOT, 't2')
    fireEvent.click(screen.getByRole('button', { name: 'Open: Your chat with CoS' }))
    expect(mocks.openHome).toHaveBeenCalledWith(BOT)
  })

  it('sends a connector sign-in to its Connectors page and opens the exact runs it stopped', () => {
    renderNeeds(
      [{ kind: 'connector', key: 'connector:linear:w1', connector: LINEAR }],
      [automationRow('a2', 'Label new Linear bugs', 'run-9')]
    )

    fireEvent.click(screen.getByRole('button', { name: 'Open Linear' }))
    expect(mocks.manageConnectors).toHaveBeenCalledWith(BOT, 'linear:w1')
    fireEvent.click(screen.getByRole('button', { name: 'Open run: Label new Linear bugs' }))
    expect(mocks.openAutomation).toHaveBeenLastCalledWith('a2', 'run-9')
  })

  it('titles an item’s worker ask with the item, naming the worker and the tool it asks for', () => {
    renderNeeds([
      workerAsk('d-wake', 'Webhook wake-up', { tool: { name: 'Bash', input: 'git push origin' } }),
      workerAsk('d-other', 'Rotate fix')
    ])

    fireEvent.click(
      screen.getByRole('button', { name: 'Open: Wake the item’s chat when a linked PR merges' })
    )
    expect(mocks.openWorker).toHaveBeenCalledOnce()
    expect(screen.getByText('#7')).toBeTruthy()
    expect(screen.getByText('Worker: Webhook wake-up')).toBeTruthy()
    expect(screen.getByText('git push origin')).toBeTruthy()
    // No item and no tool: its own title, and what any approval says.
    const rotate = screen.getByRole('button', { name: 'Open: Rotate fix' })
    expect(rotate.textContent).toBe('Rotate fix')
    expect(
      document.getElementById(rotate.getAttribute('aria-describedby') ?? '')?.textContent
    ).toBe('Permission needed')
  })

  it('says where a worker with nowhere to open runs, with no action', () => {
    renderNeeds([workerAsk('', 'Codex in scratch folder')])

    expect(shownActions()).toEqual([])
    expect(screen.getByText('Permission needed · open it where it runs')).toBeTruthy()
  })
})

describe('Needs you folds long lists', () => {
  it('folds only once two or more rows would hide', () => {
    const update = renderNeeds(asks(6))
    expect(footer()).toBeNull()
    expect(shownActions()).toHaveLength(6)

    update(asks(7))
    expect(footer()).toBe('Show 2 more')
    expect(shownActions()).toHaveLength(5)
    update(asks(8))
    expect(footer()).toBe('Show 3 more')
    expect(shownActions()).toHaveLength(5)
  })

  it('opens in place; growing back past the cap starts folded', () => {
    const update = renderNeeds(asks(8))

    fireEvent.click(screen.getByRole('button', { name: 'Show 3 more' }))
    expect(shownActions()).toHaveLength(8)
    expect(footer()).toBeNull()

    update(asks(6))
    update(asks(8))
    expect(footer()).toBe('Show 3 more')
  })

  it('stays open through a spell offline', () => {
    const update = renderNeeds(asks(8))
    fireEvent.click(screen.getByRole('button', { name: 'Show 3 more' }))

    update(asks(8), true)
    update(asks(8), false)
    expect(footer()).toBeNull()
    expect(shownActions()).toHaveLength(8)
  })

  it('keeps its order apart from approvals, which come first and never fold', () => {
    renderNeeds([
      asking(1),
      { kind: 'connector', key: 'connector:linear:w1', connector: LINEAR },
      ...[2, 3, 4, 5, 6].map((n) => asking(n)),
      asking(7, APPROVAL)
    ])

    expect(shownActions()).toEqual([
      'Open: Ask 7',
      'Open: Ask 1',
      'Open Linear',
      'Open: Ask 2',
      'Open: Ask 3'
    ])
    expect(footer()).toBe('Show 3 more')
  })

  it('shows every approval past the cap', () => {
    renderNeeds([asking(1), asking(2), ...[3, 4, 5, 6, 7, 8, 9].map((n) => asking(n, APPROVAL))])

    expect(shownActions()).toEqual([3, 4, 5, 6, 7, 8, 9].map((n) => `Open: Ask ${n}`))
    expect(footer()).toBe('Show 2 more')
  })
})

describe('Needs you keeps keyboard focus', () => {
  const focused = (): string | null =>
    document.activeElement?.getAttribute('aria-label') ??
    document.activeElement?.textContent ??
    null

  it('keeps the focused row shown when a sort pushes it past the cap, until focus leaves', () => {
    renderNeeds(asks(7))
    act(() => screen.getByRole('button', { name: 'Open: Ask 5' }).focus())

    expect(shownActions()).not.toContain('Open: Ask 7')
    setPrompt(7, APPROVAL)
    expect(shownActions()[0]).toBe('Open: Ask 7')
    expect(screen.getByRole('button', { name: 'Open: Ask 5' })).toBeTruthy()
    expect(focused()).toBe('Open: Ask 5')
    expect(footer()).toBe('Show 1 more')

    act(() => screen.getByRole('button', { name: 'Outside' }).focus())
    expect(screen.queryByRole('button', { name: 'Open: Ask 5' })).toBeNull()
    expect(footer()).toBe('Show 2 more')
  })

  it('moves focus from the footer it opened to the last row', () => {
    renderNeeds(asks(8))
    const more = screen.getByRole('button', { name: 'Show 3 more' })
    act(() => more.focus())
    fireEvent.click(more)
    expect(focused()).toBe('Open: Ask 8')
  })

  it('moves focus from the footer to the panel offline, when every control is off', () => {
    const update = renderNeeds(asks(8))
    act(() => screen.getByRole('button', { name: 'Show 3 more' }).focus())
    update(asks(8), true)
    expect(shownActions()).toHaveLength(8)
    expect(footer()).toBeNull()
    expect(document.activeElement).toBe(screen.getByTestId('panel'))
  })

  it('moves focus to the row a removal brings up from the fold', () => {
    const update = renderNeeds(asks(8))
    act(() => screen.getByRole('button', { name: 'Open: Ask 5' }).focus())

    update(asks(8).filter((need) => need.key !== 'thread:t5'))
    expect(focused()).toBe('Open: Ask 6')
  })

  it('moves focus to the next row when its row leaves, the previous one for the last row', () => {
    const update = renderNeeds(asks(3))
    act(() => screen.getByRole('button', { name: 'Open: Ask 2' }).focus())

    update([asking(1), asking(3)])
    expect(focused()).toBe('Open: Ask 3')
    update([asking(1)])
    expect(focused()).toBe('Open: Ask 1')
    update([])
    expect(document.activeElement).toBe(screen.getByTestId('panel'))
  })

  it('skips rows with no action', () => {
    const handed = workerAsk('', 'Handed worker', { dot: 'waiting' })
    const update = renderNeeds([asking(1), asking(2, APPROVAL), handed, asking(3)])
    act(() => screen.getByRole('button', { name: 'Open: Ask 1' }).focus())

    // Ask 2's approval sorts first, so Ask 1 is followed by the worker with no action, then Ask 3.
    update([asking(2, APPROVAL), handed, asking(3)])
    expect(focused()).toBe('Open: Ask 3')
    update([asking(2, APPROVAL), handed])
    expect(focused()).toBe('Open: Ask 2')
  })

  it('leaves focus where the owner took it when the row then leaves or sorts', () => {
    const update = renderNeeds(asks(7))
    act(() => screen.getByRole('button', { name: 'Open: Ask 2' }).focus())
    // Open goes to the chat, which takes focus outside the group.
    act(() => screen.getByRole('button', { name: 'Outside' }).focus())

    setPrompt(7, APPROVAL)
    expect(focused()).toBe('Outside')
    update([asking(1), ...[3, 4, 5, 6].map((n) => asking(n)), asking(7, APPROVAL)])
    expect(focused()).toBe('Outside')
  })

  it('leaves focus that another effect moved outside in the same commit its row left', () => {
    const update = renderNeeds(asks(3))
    act(() => screen.getByRole('button', { name: 'Open: Ask 2' }).focus())

    update([asking(1), asking(3)], false, true)
    expect(focused()).toBe('Outside')
  })

  it('keeps focus on a row whose approval turns back into a question', () => {
    renderNeeds([asking(1), asking(2, APPROVAL)])
    act(() => screen.getByRole('button', { name: 'Open: Ask 2' }).focus())

    setPrompt(2, QUESTION)
    expect(shownActions()).toEqual(['Open: Ask 1', 'Open: Ask 2'])
    expect(focused()).toBe('Open: Ask 2')
  })

  it('falls back to the panel when every control is off', () => {
    const update = renderNeeds(asks(2))
    act(() => screen.getByRole('button', { name: 'Open: Ask 1' }).focus())

    update([asking(2)], true)
    expect(document.activeElement).toBe(screen.getByTestId('panel'))
  })
})
