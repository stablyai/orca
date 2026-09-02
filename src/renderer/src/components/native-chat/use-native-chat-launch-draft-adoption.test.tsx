// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatLaunchDraft } from '@/lib/native-chat-launch-prompt'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import {
  useNativeChatLaunchDraftAdoption,
  useNativeChatLaunchDraftSignal
} from './use-native-chat-launch-draft-adoption'

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

function setup(args: {
  launchDraft: NativeChatLaunchDraft | null
  launchDraftResolved?: boolean
  draft?: string
  agent?: string
  ownsTabWideLaunchDraft?: boolean
}): { setDraft: ReturnType<typeof vi.fn>; setCaret: ReturnType<typeof vi.fn> } {
  const setDraft = vi.fn()
  const setCaret = vi.fn()
  renderHook(() =>
    useNativeChatLaunchDraftAdoption({
      terminalTabId: 'tab-1',
      agent: args.agent ?? 'claude',
      launchDraft: args.launchDraft,
      launchDraftResolved: args.launchDraftResolved ?? false,
      draft: args.draft ?? '',
      setDraft,
      setCaret,
      ownsTabWideLaunchDraft: args.ownsTabWideLaunchDraft ?? true
    })
  )
  return { setDraft, setCaret }
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
        messages: props.messages,
        transcriptLoading: props.transcriptLoading === true
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

  it('resolves on an undated user turn (Grok omits row timestamps)', () => {
    const { result } = renderSignal([userTurn('u1', null)])

    expect(result.current.launchDraftResolved).toBe(true)
  })

  it('resolves a new turn even when the executing host clock runs far behind', () => {
    // SSH/remote workspaces stamp the JSONL on the other host's clock, so no
    // timestamp on either side proves the turn is new — the baseline does.
    const stale = userTurn('u1', SEEDED_AT - 600_000)
    const { result, rerender } = renderSignal([stale])
    expect(result.current.launchDraftResolved).toBe(false)

    rerender({ messages: [stale, userTurn('u2', SEEDED_AT - 599_000)] })
    expect(result.current.launchDraftResolved).toBe(true)
  })

  it('does not resolve when "load earlier" only prepends older history', () => {
    const tail = userTurn('u9', SEEDED_AT - 600_000)
    const { result, rerender } = renderSignal([tail])
    expect(result.current.launchDraftResolved).toBe(false)

    rerender({ messages: [userTurn('u7', SEEDED_AT - 900_000), tail] })
    expect(result.current.launchDraftResolved).toBe(false)
  })

  it('does not resolve when a loading transcript backfills older history', () => {
    // The baseline must not be snapshotted on the empty in-flight list: the
    // backfill itself would then push the count above it and silently drop a
    // seed the user never saw.
    const { result, rerender } = renderSignal([], true)
    expect(result.current.launchDraftResolved).toBe(false)

    rerender({
      messages: [
        userTurn('u1', SEEDED_AT - 900_000),
        userTurn('u2', SEEDED_AT - 800_000),
        userTurn('u3', SEEDED_AT - 700_000)
      ],
      transcriptLoading: false
    })

    expect(result.current.launchDraftResolved).toBe(false)
    expect(result.current.launchDraft).not.toBeNull()
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
    // Discarding it and re-taking from the fuller list would swallow the very
    // user turn that resolves the draft, so a stale prefill gets re-adopted.
    const { result, rerender } = renderSignal([])
    expect(result.current.launchDraftResolved).toBe(false)

    // Provably older than the seed, so only the baseline can resolve it.
    const turn = userTurn('u1', SEEDED_AT - 600_000)
    rerender({ messages: [turn], transcriptLoading: true })
    expect(result.current.launchDraftResolved).toBe(false)

    rerender({ messages: [turn], transcriptLoading: false })
    expect(result.current.launchDraftResolved).toBe(true)
  })

  it('does not resolve from an in-flight transcript that still shows recent turns', () => {
    // A read in flight can still be rendering the previous generation's tail;
    // those turns say nothing about this draft.
    const { result } = renderSignal([userTurn('u1', SEEDED_AT)], true)

    expect(result.current.launchDraftResolved).toBe(false)
    expect(result.current.launchDraft).not.toBeNull()
  })

  it('resolves immediately from an accepted mobile submission', () => {
    mocks.storeState.nativeChatLaunchDraftByTabId = {
      'tab-1': launchDraft({ adopted: true, resolved: true, createdAt: SEEDED_AT })
    }

    const { result } = renderSignal([], true)

    expect(result.current.launchDraftResolved).toBe(true)
    expect(result.current.launchDraft?.resolved).toBe(true)
  })

  it("selects the tab's seed for every pane so the resolution machine keeps running", () => {
    // Pane ownership gates the composer *write*, not the signal: nulling it here
    // would also kill the resolved/cleanup branch for a split tab.
    const { result } = renderSignal([])

    expect(result.current.launchDraft?.text).toBe(SEED_TEXT)
  })

  it('ignores a draft seeded for another agent', () => {
    mocks.storeState.nativeChatLaunchDraftByTabId = {
      'tab-1': launchDraft({ agent: 'codex', createdAt: SEEDED_AT })
    }
    const { result } = renderSignal([userTurn('u1', null)])

    expect(result.current.launchDraft).toBeNull()
    expect(result.current.launchDraftResolved).toBe(false)
  })
})

describe('useNativeChatLaunchDraftAdoption', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('adopts an unadopted seed into an empty composer', () => {
    const entry = launchDraft()
    const { setDraft, setCaret } = setup({ launchDraft: entry })

    expect(mocks.markNativeChatLaunchDraftAdopted).toHaveBeenCalledWith('tab-1')
    expect(setDraft).toHaveBeenCalledWith(entry.text)
    expect(setCaret).toHaveBeenCalledWith(entry.text.length)
    expect(mocks.clearNativeChatLaunchDraft).not.toHaveBeenCalled()
  })

  it('declines the seed permanently when the composer already holds text', () => {
    const { setDraft } = setup({ launchDraft: launchDraft(), draft: 'user typed first' })

    expect(mocks.markNativeChatLaunchDraftAdopted).toHaveBeenCalledWith('tab-1')
    expect(setDraft).not.toHaveBeenCalled()
  })

  it('does nothing for a different agent or a missing seed', () => {
    setup({ launchDraft: launchDraft({ agent: 'codex' }) })
    setup({ launchDraft: null })

    expect(mocks.markNativeChatLaunchDraftAdopted).not.toHaveBeenCalled()
    expect(mocks.clearNativeChatLaunchDraft).not.toHaveBeenCalled()
  })

  it('does not re-adopt an already adopted seed after the user clears the composer', () => {
    const { setDraft } = setup({ launchDraft: launchDraft({ adopted: true }), draft: '' })

    expect(setDraft).not.toHaveBeenCalled()
    expect(mocks.markNativeChatLaunchDraftAdopted).not.toHaveBeenCalled()
  })

  it('clears an untouched adopted copy once the transcript resolves the draft', () => {
    const entry = launchDraft({ adopted: true })
    const { setDraft, setCaret } = setup({
      launchDraft: entry,
      launchDraftResolved: true,
      draft: entry.text
    })

    expect(setDraft).toHaveBeenCalledWith('')
    expect(setCaret).toHaveBeenCalledWith(0)
    expect(mocks.clearNativeChatLaunchDraft).toHaveBeenCalledWith('tab-1')
  })

  it('keeps user edits when the transcript resolves the draft', () => {
    const { setDraft } = setup({
      launchDraft: launchDraft({ adopted: true }),
      launchDraftResolved: true,
      draft: 'edited context'
    })

    expect(setDraft).not.toHaveBeenCalled()
    expect(mocks.clearNativeChatLaunchDraft).toHaveBeenCalledWith('tab-1')
  })

  it('does not mirror the seed into a pane that does not own the tab-wide evidence', () => {
    const { setDraft } = setup({ launchDraft: launchDraft(), ownsTabWideLaunchDraft: false })

    expect(setDraft).not.toHaveBeenCalled()
    expect(mocks.markNativeChatLaunchDraftAdopted).not.toHaveBeenCalled()
  })

  it('leaves an unadopted seed alone when a non-owning pane resolves it', () => {
    // The owner may not have mirrored it yet; a sibling's transcript is no
    // evidence about the owner's copy.
    setup({ launchDraft: launchDraft(), launchDraftResolved: true, ownsTabWideLaunchDraft: false })

    expect(mocks.clearNativeChatLaunchDraft).not.toHaveBeenCalled()
  })

  it('drops an unadopted seed once the transcript resolves it', () => {
    const { setDraft } = setup({ launchDraft: launchDraft(), launchDraftResolved: true })

    expect(setDraft).not.toHaveBeenCalled()
    expect(mocks.markNativeChatLaunchDraftAdopted).not.toHaveBeenCalled()
    expect(mocks.clearNativeChatLaunchDraft).toHaveBeenCalledWith('tab-1')
  })
})

describe('launch draft adoption across a split', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.storeState.nativeChatLaunchDraftByTabId = {
      'tab-1': launchDraft({ createdAt: SEEDED_AT })
    }
  })

  function renderPaneComposer(args: {
    ownsTabWideLaunchDraft: boolean
    draft?: string
    messages?: NativeChatMessage[]
  }): { setDraft: ReturnType<typeof vi.fn>; setCaret: ReturnType<typeof vi.fn> } {
    const setDraft = vi.fn()
    const setCaret = vi.fn()
    renderHook(() => {
      const signal = useNativeChatLaunchDraftSignal({
        terminalTabId: 'tab-1',
        agent: 'claude',
        messages: args.messages ?? [],
        transcriptLoading: false
      })
      useNativeChatLaunchDraftAdoption({
        terminalTabId: 'tab-1',
        agent: 'claude',
        launchDraft: signal.launchDraft,
        launchDraftResolved: signal.launchDraftResolved,
        draft: args.draft ?? '',
        setDraft,
        setCaret,
        ownsTabWideLaunchDraft: args.ownsTabWideLaunchDraft
      })
    })
    return { setDraft, setCaret }
  }

  it("never fills a non-owning pane's composer with the tab's launch draft", () => {
    const { setDraft } = renderPaneComposer({ ownsTabWideLaunchDraft: false })

    expect(setDraft).not.toHaveBeenCalled()
    expect(mocks.markNativeChatLaunchDraftAdopted).not.toHaveBeenCalled()
  })

  it('never lets a non-owning pane destroy a seed nobody has adopted yet', () => {
    const { setDraft } = renderPaneComposer({
      ownsTabWideLaunchDraft: false,
      messages: [userTurn('u1', null)]
    })

    expect(setDraft).not.toHaveBeenCalled()
    expect(mocks.clearNativeChatLaunchDraft).not.toHaveBeenCalled()
  })

  it('still mirrors the launch draft into the owning pane composer', () => {
    const { setDraft } = renderPaneComposer({ ownsTabWideLaunchDraft: true })

    expect(setDraft).toHaveBeenCalledWith(SEED_TEXT)
  })

  it('clears the adopted copy after a split once the transcript resolves the seed', () => {
    // Splitting drops ownership for *both* panes, so the pane that already
    // mirrored the seed must still clean up — otherwise the submitted prompt
    // sits in its composer forever and a later Enter re-sends it (#16695).
    mocks.storeState.nativeChatLaunchDraftByTabId = {
      'tab-1': launchDraft({ adopted: true, createdAt: SEEDED_AT })
    }

    const { setDraft, setCaret } = renderPaneComposer({
      ownsTabWideLaunchDraft: false,
      draft: SEED_TEXT,
      messages: [userTurn('u1', null)]
    })

    expect(setDraft).toHaveBeenCalledWith('')
    expect(setCaret).toHaveBeenCalledWith(0)
    expect(mocks.clearNativeChatLaunchDraft).toHaveBeenCalledWith('tab-1')
  })
})
