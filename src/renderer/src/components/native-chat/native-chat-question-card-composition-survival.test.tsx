// @vitest-environment happy-dom

/** A question card fully replaces the composer (`NativeChatView.tsx`,
 *  `{questionActive ? null : <NativeChatComposer/>}`) because the card supplies
 *  its own answer input. That swap unmounts the composer mid-composition, and
 *  the composer never receives `compositionend`. The preedit survives anyway,
 *  and this file pins the chain that carries it.
 *
 *  A real IME fires `input` (inputType `insertCompositionText`) for every
 *  preedit mutation — see the observation-derived sequence in
 *  `tests/e2e/terminal-ime-observed-event-sequences.ts`. React dispatches
 *  `onChange` on those events with no composition gate (react-dom's
 *  `getTargetInstForInputOrChangeEvent` keys only on `input`/`change`), so
 *  `handleDraftChange` runs per keystroke and `setDraft` writes the preedit
 *  straight through to the draft cache. The remounted textarea then restores it
 *  via `defaultValue={draft}`. `compositionend` is a reconciliation fallback,
 *  not the commit path.
 *
 *  CORRECTION TO A PUSHED COMMIT. `61977d45177` ("characterize preedit loss
 *  when a question card replaces the composer") asserted this loss as a real
 *  data-loss path — "the preedit is never committed to the draft", "the 가 is
 *  gone". That is false, and since it is pushed the history cannot be quietly
 *  corrected, so the correction lives here: the loss was an artifact of that
 *  file's own harness, which assigned `textarea.value` directly with no `input`
 *  event — something no IME does. Production never behaved that way. The
 *  surviving contract below is what actually holds. Drive composition through
 *  the frames below or the artifact reappears and looks like a defect again.
 *
 *  NOW A REGRESSION GUARD, because the defect it characterized is fixed.
 *  The swap used to ABORT a live composition on real Windows TSF: the old node
 *  got a `blur` and no `compositionend`, the text returned committed, and the
 *  next jamo yielded `아ㄴ` rather than `안`. `useNativeChatComposerCompositionHold`
 *  now defers the unmount while a composition is in flight, so the composing
 *  node is never destroyed. The cases below pin BOTH halves: the text survives
 *  (what reporters already agreed with — "값은 보존되나") and the node itself
 *  survives, which is what keeps the composition alive.
 *
 *  Why the node identity assertions are load-bearing: value-only assertions are
 *  trivially satisfied by a composer that never unmounts, so they cannot tell a
 *  held composition from a destroyed one. `isConnected` and node identity can.
 *
 *  The abort itself is still not directly assertable in happy-dom — `value` reads
 *  the same for committed text and a live preedit, and there is no EditContext —
 *  so the guard is the node's survival, and the drawn proof lives on Windows
 *  (`.tmp/ime-handoff/swarm-scratch/wave26-12118-fix/`).
 *
 *  The cadence objection stands and is still the open question. Those reporters
 *  describe continuous flicker keyed to streaming token counters and elapsed
 *  timers, and those drivers provably do not remount the composer —
 *  `native-chat-composer-autogrow.test.tsx` holds node identity across 120 such
 *  rerenders. An AskUserQuestion card arrives once per question, which does not
 *  match that cadence, so whether this owner is the one they hit is unproven.
 *
 *  RESIDUAL, now addressed AT THIS SITE. Mid-syllable Hangul used to return as a
 *  standalone compatibility jamo (U+3131 ㄱ) — not a composable state, so the
 *  user had to delete and retype. That degradation was downstream of the abort;
 *  with no abort there is nothing to degrade. Any OTHER path that aborts a
 *  composition would still produce it, so the note is kept rather than deleted.
 *
 *  Geometry stays unasserted — happy-dom has no layout engine. */

import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const PANE_KEY = 'tab-1:leaf-1'

const ASK_USER_QUESTION = JSON.stringify({
  questions: [
    {
      question: 'Tabs or spaces?',
      multiSelect: false,
      options: [{ label: 'Tabs' }, { label: 'Spaces' }]
    }
  ]
})

const { storeState } = vi.hoisted(() => ({
  storeState: {
    agentStatusByPaneKey: {
      'tab-1:leaf-1': { interactivePrompt: null as string | null, toolName: 'AskUserQuestion' }
    } as Record<string, Record<string, unknown>>,
    nativeChatLaunchPromptByTabId: {} as Record<string, unknown>,
    nativeChatLaunchDraftByTabId: {} as Record<string, unknown>,
    tabsByWorktree: {} as Record<string, unknown>,
    unifiedTabs: [] as unknown[],
    settings: { voice: { enabled: false, sttModel: null as string | null } },
    dictationState: null as string | null,
    clearNativeChatLaunchPrompt: () => {},
    clearNativeChatLaunchDraft: () => {}
  }
}))

vi.mock('../../store', () => ({
  useAppStore: Object.assign(
    (selector?: (state: typeof storeState) => unknown) =>
      selector ? selector(storeState) : storeState,
    { getState: () => storeState }
  )
}))

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

// Data sources and unrelated siblings are stubbed; the interactive card, the
// questionActive swap, and the composer itself stay real. The stubs return
// stable identities like the real memoized hooks do — fresh objects per render
// would retrigger identity-keyed effects and mask the behavior under test.
const { liveSession, interactiveSend } = vi.hoisted(() => ({
  liveSession: {
    messages: [
      { id: 'm1', role: 'assistant', blocks: [{ type: 'text', text: 'streaming' }], timestamp: 1 }
    ],
    readPhase: 'ready',
    status: 'working'
  },
  interactiveSend: {
    sendAnswer: () => ({ settleAfterMs: 0, waitsForVerifiedDelivery: false }),
    sendRaw: () => {},
    cancelPending: () => {},
    cancel: () => {}
  }
}))

vi.mock('./use-native-chat-live-session', () => ({
  useNativeChatLiveSession: () => liveSession
}))
vi.mock('./use-native-chat-can-send', () => ({ useNativeChatCanSend: () => true }))
vi.mock('./use-native-chat-interactive-send', () => ({
  useNativeChatInteractiveSend: () => interactiveSend
}))
vi.mock('./NativeChatMessageList', () => ({
  NativeChatMessageList: () => <div data-testid="message-list" />
}))
vi.mock('./use-native-chat-context-menu', () => ({
  emptyNativeChatContextMenuActions: {},
  useNativeChatContextMenu: () => ({
    menu: null,
    onSelectionCapture: vi.fn(),
    onContextMenuCapture: vi.fn()
  })
}))
vi.mock('./use-native-chat-font-scale', () => ({
  useNativeChatFontScale: () => ({ scale: 1 })
}))
vi.mock('./NativeChatComposerActions', () => ({
  NativeChatComposerActions: () => <div data-testid="composer-actions" />
}))
vi.mock('./use-native-chat-session-options', () => ({
  useNativeChatSessionOptions: () => ({ surface: null, snapshot: [] })
}))

import NativeChatView from './NativeChatView'
import {
  clearNativeChatDraftCacheForTests,
  readNativeChatDraftCache
} from './native-chat-draft-cache'

// Preload bridge surface the composer subscribes to on mount.
beforeAll(() => {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      ui: { onFileDrop: () => () => {} },
      shell: { pickAttachment: async () => [] }
    }
  })
})

afterEach(() => {
  cleanup()
  clearNativeChatDraftCacheForTests()
  storeState.agentStatusByPaneKey[PANE_KEY] = {
    interactivePrompt: null,
    toolName: 'AskUserQuestion'
  }
})

function view(): React.JSX.Element {
  return (
    <NativeChatView
      terminalTabId="tab-1"
      paneKey={PANE_KEY}
      targetPtyId="pty-1"
      launchAgent="claude"
      resolvedAgent="claude"
    />
  )
}

/** The composer textarea, or null while the question card owns the input region.
 *  Keyed on the placeholder so the card's own answer input is never mistaken
 *  for it. */
function composerTextarea(): HTMLTextAreaElement | null {
  return document.querySelector('textarea[placeholder]')
}

function setInteractivePrompt(prompt: string | null, rendered: ReturnType<typeof render>): void {
  act(() => {
    storeState.agentStatusByPaneKey[PANE_KEY].interactivePrompt = prompt
    rendered.rerender(view())
  })
}

/** One preedit mutation as an IME delivers it: the composition text updates and
 *  the element's value is replaced, both reported through `input`. Assigning
 *  `value` without this is what made the loss look real. */
function composeFrame(el: HTMLTextAreaElement, value: string, data: string): void {
  fireEvent.compositionUpdate(el, { data })
  // `isComposing` is set as well as `inputType`: a gate on either one is a plausible
  // regression, and omitting it silently exempted the `isComposing` variant.
  fireEvent.input(el, {
    target: { value },
    inputType: 'insertCompositionText',
    data,
    isComposing: true
  })
}

describe('native chat question card vs an in-flight composition', () => {
  it('keeps an active Hangul preedit across the swap', () => {
    const rendered = render(view())
    const before = composerTextarea()
    expect(before).not.toBeNull()

    // Committed draft is "abc"; the user now composes Hangul onto the end,
    // one jamo per frame.
    fireEvent.change(before!, { target: { value: 'abc' } })
    fireEvent.compositionStart(before!)
    composeFrame(before!, 'abcㄱ', 'ㄱ')
    composeFrame(before!, 'abc가', '가')

    // An AskUserQuestion card arrives mid-composition. The swap is DEFERRED:
    // destroying this node is what aborts the composition in the OS.
    setInteractivePrompt(ASK_USER_QUESTION, rendered)
    expect(composerTextarea()).toBe(before)
    expect(before!.isConnected).toBe(true)

    // The agent moves on and the prompt clears.
    setInteractivePrompt(null, rendered)
    const after = composerTextarea()

    // The SAME node throughout — never remounted, so the composition it owns is
    // still live and the next jamo can still join the open syllable.
    expect(after).toBe(before)
    expect(after!.value).toBe('abc가')
  })

  it('yields the input region once the composition ends under a live card', () => {
    const rendered = render(view())
    const before = composerTextarea()
    expect(before).not.toBeNull()

    fireEvent.compositionStart(before!)
    composeFrame(before!, '가', '가')
    setInteractivePrompt(ASK_USER_QUESTION, rendered)
    expect(composerTextarea()).toBe(before)

    // The hold is only owed to a composition in flight; once it resolves the
    // card takes the input region as designed.
    act(() => {
      fireEvent.compositionEnd(before!, { data: '가', target: { value: '가' } })
    })
    expect(composerTextarea()).toBeNull()
    expect(before!.isConnected).toBe(false)
  })

  it('keeps the live conversion candidate of a multi-segment Japanese composition', () => {
    const rendered = render(view())
    const before = composerTextarea()
    expect(before).not.toBeNull()

    // Japanese stays composing far longer than Hangul: kana first, then
    // per-segment conversion, all inside one composition.
    fireEvent.compositionStart(before!)
    composeFrame(before!, 'か', 'か')
    composeFrame(before!, 'かんじ', 'かんじ')
    composeFrame(before!, 'かんじへんかん', 'かんじへんかん')
    composeFrame(before!, '漢字へんかん', '漢字へんかん')
    // Second segment converted; the card lands on this candidate.
    composeFrame(before!, '漢字変換', '漢字変換')

    setInteractivePrompt(ASK_USER_QUESTION, rendered)
    setInteractivePrompt(null, rendered)

    const after = composerTextarea()
    expect(after).not.toBeNull()
    // The candidate the user was looking at, not the kana it started from.
    expect(after!.value).toBe('漢字変換')
  })

  it('mirrors the preedit into the draft cache as the card arrives', () => {
    const rendered = render(view())
    const before = composerTextarea()
    expect(before).not.toBeNull()

    fireEvent.compositionStart(before!)
    composeFrame(before!, '가', '가')

    // The mechanism, pinned directly: onChange fires on composition `input`
    // frames, so the draft cache — not the unmounted DOM node — is what carries
    // the preedit across the swap. Gating onChange on either `isComposing` or
    // `inputType` breaks here — the frames now carry both, so neither gate is
    // exempt. Previously only `inputType` was set, so an `isComposing` gate
    // passed this suite untouched despite the claim.
    setInteractivePrompt(ASK_USER_QUESTION, rendered)
    expect(readNativeChatDraftCache(PANE_KEY)).toBe('가')
  })

  it('leaves an ordinary committed English draft unchanged through the same swap', () => {
    const rendered = render(view())
    const before = composerTextarea()
    expect(before).not.toBeNull()

    // No composition in flight, so there is nothing browser-owned to lose.
    fireEvent.change(before!, { target: { value: 'abc' } })

    // THE NEGATIVE: with nothing composing, the card replaces the composer
    // immediately, exactly as before the hold existed. A hold that fired here
    // would leave a stray "Send a message" beside the card.
    setInteractivePrompt(ASK_USER_QUESTION, rendered)
    expect(composerTextarea()).toBeNull()
    expect(before!.isConnected).toBe(false)

    setInteractivePrompt(null, rendered)
    const after = composerTextarea()
    expect(after).not.toBeNull()
    expect(after!.value).toBe('abc')
  })
})
