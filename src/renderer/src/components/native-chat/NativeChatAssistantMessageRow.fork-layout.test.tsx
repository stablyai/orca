// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, screen } from '@testing-library/react'
import { render } from './native-chat-tooltip-test-harness'
import { afterEach, expect, it, vi } from 'vitest'
import { MessageRow, type MessageRowProps } from './NativeChatMessageRow'
import type { NativeChatForkRowAction, NativeChatForkSurface } from './use-native-chat-fork'
import { NativeChatForkContext, NativeChatForkSlotContext } from './native-chat-fork-context'
import {
  NativeChatTranscriptRow,
  type NativeChatTranscriptRowContext
} from './NativeChatTranscriptRow'
import type { NativeChatMessageSlot } from './native-chat-transcript-slots'

vi.mock('@/lib/syntax-highlighting/oniguruma', async () => ({
  loadOniguruma: (await import('@/lib/syntax-highlighting/oniguruma-test-harness'))
    .loadNodeOniguruma
}))

afterEach(cleanup)

function forkAction(overrides: Partial<NativeChatForkRowAction> = {}): NativeChatForkRowAction {
  return {
    support: { kind: 'known', fork: 'checkpoint' },
    pending: false,
    request: vi.fn(),
    ...overrides
  }
}

function renderReply(props: Partial<MessageRowProps>): HTMLElement {
  const { container } = render(
    <MessageRow
      message={{
        id: 'reply',
        role: 'assistant',
        timestamp: 0,
        source: 'transcript',
        blocks: [{ type: 'text', text: 'Looking at the config next.' }]
      }}
      expandSignal={false}
      onScrollMessageToTop={vi.fn()}
      {...props}
    />
  )
  return container.querySelector<HTMLElement>('.group')!
}

const forkButton = () => screen.getByRole('button', { name: 'Fork from this response' })

it('draws Fork in the response hover row right after Copy, and forks that response', () => {
  const fork = forkAction()
  renderReply({ fork })
  const copy = screen.getByRole('button', { name: 'Copy message' })

  expect(copy.parentElement).toBe(forkButton().parentElement)
  expect(copy.nextElementSibling).toBe(forkButton())
  fireEvent.click(forkButton())
  expect(fork.request).toHaveBeenCalledWith('reply')
})

it('keeps the hover row the same whether Fork is still being checked or ready', () => {
  const shape = (row: HTMLElement) => {
    const controls = forkButton().parentElement!
    return { lines: row.children.length, buttons: controls.querySelectorAll('button').length }
  }
  const checking = shape(renderReply({ fork: forkAction({ support: { kind: 'unknown' } }) }))
  expect(forkButton()).toHaveAttribute('aria-disabled', 'true')
  cleanup()
  const ready = shape(renderReply({ fork: forkAction() }))
  expect(forkButton()).toHaveAttribute('aria-disabled', 'false')

  expect(ready).toEqual(checking)
})

it("draws the hover row on a turn's last words even when tools follow, and not on earlier words", () => {
  renderReply({ fork: forkAction(), continuesTurn: true, endsResponse: false })
  expect(screen.queryByRole('button', { name: 'Fork from this response' })).toBeNull()
  cleanup()
  renderReply({ fork: forkAction(), continuesTurn: true, endsResponse: true })
  expect(screen.getByRole('button', { name: 'Fork from this response' })).toBeInTheDocument()
})

it('keeps the hover row the same on an older turn when unknown support resolves to tip-only', () => {
  const message = {
    id: 'reply',
    role: 'assistant' as const,
    timestamp: 0,
    source: 'transcript' as const,
    blocks: [{ type: 'text' as const, text: 'Looking at the config next.' }],
    journalPosition: { sequence: 3, index: 0 }
  }
  const slot: NativeChatMessageSlot = {
    kind: 'message',
    message,
    turnKey: 'older-turn',
    endsResponse: true,
    activeTurnIsWorking: false,
    trailingRun: false,
    receipt: undefined,
    status: undefined,
    folded: false,
    drawsMessage: true,
    turnFolds: false,
    turnDiff: undefined,
    subagentRoster: undefined,
    depth: 0,
    estimatedHeight: 40
  }
  const context: NativeChatTranscriptRowContext = {
    expandSignal: false,
    revealedDiff: null,
    taskListPredecessors: new Map(),
    expandedTurnIds: new Set(),
    latestTurnKey: 'newer-turn',
    onToggleExpandedTurn: () => {},
    subagentDisclosure: { setSectionOpen: () => {}, setRosterOpen: () => {} },
    onScrollMessageToTop: () => {},
    onRevealDiff: () => {}
  }
  const surface = (support: NativeChatForkSurface['support']): NativeChatForkSurface => {
    const rowAction = { support, pending: false, request: vi.fn() }
    return { ...rowAction, contextFloorSequence: 0, forkableItemIds: new Set(['reply']), rowAction }
  }
  const draw = (fork: NativeChatForkSurface) => (
    <NativeChatForkSlotContext.Provider value>
      <NativeChatForkContext.Provider value={fork}>
        <NativeChatTranscriptRow slot={slot} context={context} />
      </NativeChatForkContext.Provider>
    </NativeChatForkSlotContext.Provider>
  )
  const controlsShape = () => {
    const controls = screen.getByRole('button', { name: 'Copy message' }).parentElement!
    return Array.from(controls.children).map((child) => `${child.tagName}:${child.className}`)
  }
  const view = render(draw(surface({ kind: 'unknown' })))
  expect(screen.getByRole('button', { name: 'Fork from this response' })).toBeInTheDocument()
  const checking = controlsShape()

  // Tip-only forks reach only the newest turn, so this older reply stops offering one.
  view.rerender(draw(surface({ kind: 'known', fork: 'tip' })))

  expect(screen.queryByRole('button', { name: 'Fork from this response' })).toBeNull()
  expect(controlsShape()).toHaveLength(checking.length)
  expect(controlsShape().map((child) => child.split(':')[0])).toEqual(
    checking.map((child) => child.split(':')[0]).map((tag, index) => (index === 1 ? 'SPAN' : tag))
  )
})

it('gives an image-only action holder Fork without Copy or its context-menu target', () => {
  const request = vi.fn()
  const { container } = render(
    <MessageRow
      message={{
        id: 'a-image',
        role: 'assistant',
        timestamp: 0,
        source: 'transcript',
        blocks: [{ type: 'image-ref', url: 'https://example.test/picture.png' }]
      }}
      expandSignal={false}
      onScrollMessageToTop={vi.fn()}
      endsResponse
      fork={forkAction({ request })}
    />
  )

  fireEvent.click(forkButton())
  expect(request).toHaveBeenCalledWith('a-image')
  expect(screen.queryByRole('button', { name: 'Copy message' })).toBeNull()
  expect(container.querySelector('[data-native-chat-message-id]')).toBeNull()
})
