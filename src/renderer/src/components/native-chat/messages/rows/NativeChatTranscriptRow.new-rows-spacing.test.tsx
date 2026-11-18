// @vitest-environment happy-dom

// The "New" line's spacing is set by classes alone (happy-dom has no layout): a full row gap above
// it and a trimmed one below, whichever row comes before it and whichever place it draws in.

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  NativeChatTranscriptRow,
  type NativeChatTranscriptRowContext
} from './NativeChatTranscriptRow'
import type { NativeChatMessageSlot } from '../../conversation/slots/native-chat-transcript-slots'
import type { NativeChatNewRowsMarkerState } from '../../viewport/new-rows/native-chat-new-rows-marker'
import {
  NativeChatSlackMirrorContext,
  type NativeChatSlackMirror
} from '../../slack-mirror/native-chat-slack-mirror'

vi.mock('./NativeChatMessageRow', () => ({
  MessageRow: () => <div data-testid="message" />
}))
vi.mock('../../conversation/turns/NativeChatWorkingStatus', () => ({
  NativeChatWorkingStatus: () => <div data-testid="turn-bar" />
}))

afterEach(cleanup)

const context: NativeChatTranscriptRowContext = {
  expandSignal: false,
  revealedDiff: null,
  taskListPredecessors: new Map(),
  expandedTurnIds: new Set(),
  onToggleExpandedTurn: vi.fn(),
  onScrollMessageToTop: vi.fn(),
  readerAtEnd: () => true,
  onRevealDiff: vi.fn()
}

function slot(overrides: Partial<NativeChatMessageSlot> = {}): NativeChatMessageSlot {
  return {
    kind: 'message',
    message: {
      id: 'reply',
      role: 'assistant',
      source: 'transcript',
      timestamp: 1,
      blocks: [{ type: 'text', text: 'reply' }]
    },
    turnKey: 'turn',
    activeTurnIsWorking: true,
    trailingRun: false,
    receipt: undefined,
    status: undefined,
    folded: false,
    drawsMessage: true,
    turnFolds: false,
    turnDiff: undefined,
    estimatedHeight: 40,
    ...overrides
  }
}

function marker(place: NativeChatNewRowsMarkerState['place']): NativeChatNewRowsMarkerState {
  return { key: 'reply', place, arriving: false, onArrived: vi.fn(), onDismiss: vi.fn() }
}

/** The row's own flex column, which carries its gap and any pull-up margin. */
function rowBox(view: ReturnType<typeof render>): HTMLElement {
  const box = view.container.firstElementChild
  if (!(box instanceof HTMLElement)) {
    throw new Error('The row drew nothing')
  }
  return box
}

/** A bot chat's Slack thread holding the prompt's post in each state; the row reads only its posts. */
function slackMirrorWith(state: 'posting' | 'failed' | 'posted'): NativeChatSlackMirror {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the row reads only link.mirrorPosts.
  return { link: { mirrorPosts: { ask: { state, at: 1 } } } } as unknown as NativeChatSlackMirror
}
const slackMirrors = {
  posting: slackMirrorWith('posting'),
  failed: slackMirrorWith('failed'),
  posted: slackMirrorWith('posted')
}

describe('NativeChatTranscriptRow New line spacing', () => {
  it('keeps the full row gap above the line when it follows a row that pulls up', () => {
    const continuing = slot({ continuesTurn: true })
    const alone = rowBox(render(<NativeChatTranscriptRow slot={continuing} context={context} />))
    // Without the line it still pulls the next step up, as before.
    expect(alone.className).toContain('-mb-3')
    cleanup()
    const above = rowBox(
      render(<NativeChatTranscriptRow slot={continuing} context={context} newRowsMarkerBelow />)
    )
    expect(above.className).not.toContain('-mb-3')
  })

  it.each(['above-row', 'above-turn-bar'] as const)('draws the line %s in that order', (place) => {
    const view = render(
      <NativeChatTranscriptRow
        slot={slot({ status: { startedAt: 1, thinking: false, workedSeconds: null } })}
        context={context}
        newRowsMarker={marker(place)}
      />
    )
    const line = view.getByRole('separator')
    const order = [...rowBox(view).children].map((child) =>
      child === line ? 'line' : child.getAttribute('data-testid')
    )
    expect(order).toEqual(
      place === 'above-row' ? ['line', 'message', 'turn-bar'] : ['message', 'line', 'turn-bar']
    )
  })

  // Above the line: the window's row gap (above-row) or this row's gap-5 (above-turn-bar), 20px at
  // the default size. Below it, a trim of the row's gap-5; the turn bar's own top padding asks for a
  // deeper one. Your sent bubble ends in a hover-only meta row, which counts as space above.
  const user = (overrides: Partial<NativeChatMessageSlot['message']> = {}) =>
    slot({
      status: { startedAt: 1, thinking: false, workedSeconds: null },
      message: {
        id: 'ask',
        role: 'user',
        source: 'transcript',
        timestamp: 1,
        blocks: [{ type: 'text', text: 'ask' }],
        ...overrides
      }
    })
  it.each([
    ['above-row', slot(), undefined, ['-mb-1.5'], ['-mt-6', '-mb-3']],
    ['above-turn-bar', slot(), undefined, ['-mb-3'], ['-mt-6', '-mb-1.5']],
    ['above-turn-bar', user(), undefined, ['-mt-6', '-mb-3'], ['-mb-1.5']],
    [
      'above-turn-bar',
      user({ from: { kind: 'agent', senders: [], orchestration: null } }),
      undefined,
      ['-mb-3'],
      ['-mt-6']
    ],
    ['above-turn-bar', user(), { text: 'Not sent' }, ['-mb-3'], ['-mt-6']],
    ['above-turn-bar', user(), { sending: true }, ['-mb-3'], ['-mt-6']],
    ['above-turn-bar', user({ timestamp: null }), undefined, ['-mt-6', '-mb-3'], ['-mb-1.5']],
    [
      'above-turn-bar',
      user({ timestamp: null, blocks: [{ type: 'image-ref', path: '/tmp/shot.png' }] }),
      undefined,
      ['-mb-3'],
      ['-mt-6']
    ],
    ['above-turn-bar', { ...user(), drawsMessage: false }, undefined, ['-mb-3'], ['-mt-6']],
    [
      'above-row',
      slot({ statusAbove: true, status: { startedAt: 1, thinking: false, workedSeconds: null } }),
      undefined,
      ['-mb-3'],
      ['-mt-6', '-mb-1.5']
    ]
  ] as const)('spaces the line %s, case %#', (place, row, notice, has, lacks) => {
    const view = render(
      <NativeChatTranscriptRow
        slot={row}
        context={{
          ...context,
          ...(notice ? { deliveryNotices: new Map([[row.message.id, notice]]) } : {})
        }}
        newRowsMarker={marker(place)}
      />
    )
    const classes = view.getByRole('separator').className.split(' ')
    expect(classes).toEqual(expect.arrayContaining([...has]))
    for (const name of lacks) {
      expect(classes).not.toContain(name)
    }
  })

  it("skips the pull-up while a Slack post line draws under the bubble's hover row", () => {
    const lineFor = (state: keyof typeof slackMirrors): string[] => {
      const view = render(
        <NativeChatSlackMirrorContext.Provider value={slackMirrors[state]}>
          <NativeChatTranscriptRow
            slot={user()}
            context={context}
            newRowsMarker={marker('above-turn-bar')}
          />
        </NativeChatSlackMirrorContext.Provider>
      )
      const classes = view.getByRole('separator').className.split(' ')
      cleanup()
      return classes
    }
    expect(lineFor('posting')).not.toContain('-mt-6')
    expect(lineFor('failed')).not.toContain('-mt-6')
    // Once posted, nothing draws under the hover row.
    expect(lineFor('posted')).toContain('-mt-6')
  })

  it('skips the pull-up when the row draws item notes instead of the bubble', () => {
    const row = user()
    const view = render(
      <NativeChatTranscriptRow
        slot={{ ...row, itemNotes: [row.message] }}
        context={context}
        newRowsMarker={marker('above-turn-bar')}
      />
    )
    expect(view.getByRole('separator').className.split(' ')).not.toContain('-mt-6')
  })
})
