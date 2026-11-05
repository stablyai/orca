// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatLaunchDraft } from '@/lib/native-chat-launch-prompt'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
import { useNativeChatLaunchDraftSignal } from './use-native-chat-launch-draft-adoption'

const mocks = vi.hoisted(() => ({
  markNativeChatLaunchDraftAdopted: vi.fn(),
  clearNativeChatLaunchDraft: vi.fn(),
  storeState: { nativeChatLaunchDraftByTabId: {} as Record<string, NativeChatLaunchDraft> }
}))

vi.mock('../../store', () => {
  const useAppStore = ((selector: (state: unknown) => unknown) =>
    selector(mocks.storeState)) as unknown as {
    (selector: (state: unknown) => unknown): unknown
    getState: () => unknown
  }
  useAppStore.getState = () => ({
    ...mocks.storeState,
    markNativeChatLaunchDraftAdopted: mocks.markNativeChatLaunchDraftAdopted,
    clearNativeChatLaunchDraft: mocks.clearNativeChatLaunchDraft
  })
  return { useAppStore }
})

const SEED_TEXT = 'https://github.com/o/r/issues/12'

function launchDraft(overrides: Partial<NativeChatLaunchDraft> = {}): NativeChatLaunchDraft {
  return {
    tabId: 'tab-1',
    agent: 'claude',
    text: SEED_TEXT,
    createdAt: 1000,
    ...overrides
  }
}

const SEEDED_AT = 1_000_000

function userTurn(id: string, timestamp: number | null): NativeChatMessage {
  return { id, role: 'user', blocks: [{ type: 'text', text: id }], timestamp, source: 'transcript' }
}

type SignalProps = {
  messages: NativeChatMessage[]
  transcriptLoading?: boolean
}

function renderSignal(messages: NativeChatMessage[], transcriptLoading = false) {
  const initialProps: SignalProps = { messages, transcriptLoading }
  return renderHook(
    (props: SignalProps) =>
      useNativeChatLaunchDraftSignal({
        terminalTabId: 'tab-1',
        agent: 'claude',
        session: {
          messages: props.messages,
          readPhase: props.transcriptLoading === true ? 'loading' : 'ready'
        }
      }),
    { initialProps }
  )
}

describe('useNativeChatLaunchDraftSignal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.storeState.nativeChatLaunchDraftByTabId = {
      'tab-1': launchDraft({ createdAt: SEEDED_AT })
    }
  })

  it('resolves a new turn even when the executing host clock runs far behind', () => {
    // Remote JSONL timestamps use another clock; only the baseline proves a new turn.
    const stale = userTurn('u1', SEEDED_AT - 600_000)
    const { result, rerender } = renderSignal([stale])
    expect(result.current.launchDraftResolved).toBe(false)

    rerender({ messages: [stale, userTurn('u2', SEEDED_AT - 599_000)] })
    expect(result.current.launchDraftResolved).toBe(true)
  })

  it('still resolves a genuinely new turn after that backfilled history', () => {
    const history = [userTurn('u1', SEEDED_AT - 900_000), userTurn('u2', SEEDED_AT - 800_000)]
    const { result, rerender } = renderSignal([], true)

    rerender({ messages: history, transcriptLoading: false })
    expect(result.current.launchDraftResolved).toBe(false)

    rerender({
      messages: [...history, userTurn('u3', SEEDED_AT - 799_000)],
      transcriptLoading: false
    })
    expect(result.current.launchDraftResolved).toBe(true)
  })

  it('keeps a settled baseline across a later transcript reload', () => {
    // A refreshed baseline would swallow the resolving turn and re-adopt the stale prefill.
    const { result, rerender } = renderSignal([])
    expect(result.current.launchDraftResolved).toBe(false)

    // The older timestamp forces resolution through the baseline.
    const turn = userTurn('u1', SEEDED_AT - 600_000)
    rerender({ messages: [turn], transcriptLoading: true })
    expect(result.current.launchDraftResolved).toBe(false)

    rerender({ messages: [turn], transcriptLoading: false })
    expect(result.current.launchDraftResolved).toBe(true)
  })

  it('does not resolve from an in-flight transcript that still shows recent turns', () => {
    // In-flight reads may still show the previous generation’s tail.
    const { result } = renderSignal([userTurn('u1', SEEDED_AT)], true)

    expect(result.current.launchDraftResolved).toBe(false)
    expect(result.current.launchDraft).not.toBeNull()
  })
})
