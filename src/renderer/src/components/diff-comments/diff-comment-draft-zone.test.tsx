// @vitest-environment happy-dom
import { act, fireEvent, renderHook, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  useDiffCommentDraftZone,
  type UseDiffCommentDraftZoneArgs
} from './diff-comment-draft-zone'
import {
  createFakeDiffCommentEditor,
  type FakeDiffCommentEditor
} from './diff-comment-editor-test-fixture'

const DRAFT_LINE = 5
const OTHER_LINE = 9
const BODY = 'Needs revision'

type CreateComment = NonNullable<UseDiffCommentDraftZoneArgs['onCreateComment']>

function renderDraftZone(fake: FakeDiffCommentEditor, onCreateComment: CreateComment) {
  return renderHook(
    ({ monacoModelIdentity }: { monacoModelIdentity: string }) =>
      useDiffCommentDraftZone({ editor: fake.editor, monacoModelIdentity, onCreateComment }),
    { initialProps: { monacoModelIdentity: 'model-v1' } }
  )
}

function openDraftAt(hook: ReturnType<typeof renderDraftZone>, lineNumber: number): void {
  act(() => {
    hook.result.current.onAddCommentClickRef.current({ lineNumber, top: 0 })
  })
}

// The single open draft card, attached to the editor node the way Monaco would mount its zone.
function draftCard(fake: FakeDiffCommentEditor): {
  dom: HTMLElement
  textarea: HTMLTextAreaElement
} {
  const zones = [...fake.zones.values()]
  expect(zones).toHaveLength(1)
  const dom = zones[0].domNode
  if (!dom.isConnected) {
    fake.domNode.appendChild(dom)
  }
  const textarea = dom.querySelector('textarea')
  if (!(textarea instanceof HTMLTextAreaElement)) {
    throw new Error('draft card did not render a textarea')
  }
  return { dom, textarea }
}

function typeDraft(fake: FakeDiffCommentEditor, body: string): void {
  fireEvent.change(draftCard(fake).textarea, { target: { value: body } })
}

function submitDraft(fake: FakeDiffCommentEditor, body: string): void {
  typeDraft(fake, body)
  fireEvent.click(within(draftCard(fake).dom).getByRole('button', { name: 'Add note' }))
}

function deferredCreateComment(): {
  onCreateComment: CreateComment & ReturnType<typeof vi.fn>
  settle: (result: boolean) => Promise<void>
} {
  let resolve: (result: boolean) => void = () => {}
  const onCreateComment = vi.fn(
    () =>
      new Promise<boolean>((r) => {
        resolve = r
      })
  )
  return {
    onCreateComment,
    settle: (result) =>
      act(async () => {
        resolve(result)
      })
  }
}

const frames = new Map<number, FrameRequestCallback>()
let nextFrameId = 0

function pumpFrames(): void {
  const pending = [...frames.values()]
  frames.clear()
  act(() => {
    for (const callback of pending) {
      callback(16)
    }
  })
}

beforeEach(() => {
  frames.clear()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
    nextFrameId += 1
    frames.set(nextFrameId, callback)
    return nextFrameId
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frames.delete(id)
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.replaceChildren()
  vi.clearAllMocks()
})

describe('useDiffCommentDraftZone re-anchoring', () => {
  it('keeps the carried body when a second model swap lands before the re-anchor frame', () => {
    const fake = createFakeDiffCommentEditor()
    const hook = renderDraftZone(fake, vi.fn().mockResolvedValue(true))
    openDraftAt(hook, DRAFT_LINE)
    typeDraft(fake, BODY)

    hook.rerender({ monacoModelIdentity: 'model-v2' })
    hook.rerender({ monacoModelIdentity: 'model-v3' })
    expect(fake.zones.size).toBe(0)
    pumpFrames()

    const { textarea } = draftCard(fake)
    expect(textarea.value).toBe(BODY)
    expect([...fake.zones.values()][0].afterLineNumber).toBe(DRAFT_LINE)
    expect(hook.result.current.isDraftOpen()).toBe(true)
  })

  it('re-anchors the typed body onto a replacement editor', () => {
    const first = createFakeDiffCommentEditor()
    const replacement = createFakeDiffCommentEditor()
    const onCreateComment = vi.fn().mockResolvedValue(true)
    const hook = renderHook(
      ({
        fake,
        monacoModelIdentity
      }: {
        fake: FakeDiffCommentEditor
        monacoModelIdentity: string
      }) => useDiffCommentDraftZone({ editor: fake.editor, monacoModelIdentity, onCreateComment }),
      { initialProps: { fake: first, monacoModelIdentity: 'model-v1' } }
    )
    act(() => {
      hook.result.current.onAddCommentClickRef.current({ lineNumber: DRAFT_LINE, top: 0 })
    })
    typeDraft(first, BODY)

    hook.rerender({ fake: replacement, monacoModelIdentity: 'model-v2' })
    expect(first.zones.size).toBe(0)
    pumpFrames()

    expect(draftCard(replacement).textarea.value).toBe(BODY)
    expect([...replacement.zones.values()][0].afterLineNumber).toBe(DRAFT_LINE)
  })

  it('lets a click on another line win over a scheduled re-anchor', () => {
    const fake = createFakeDiffCommentEditor()
    const hook = renderDraftZone(fake, vi.fn().mockResolvedValue(true))
    openDraftAt(hook, DRAFT_LINE)
    typeDraft(fake, BODY)
    hook.rerender({ monacoModelIdentity: 'model-v2' })

    openDraftAt(hook, OTHER_LINE)
    expect(draftCard(fake).textarea.value).toBe(BODY)
    pumpFrames()

    const zones = [...fake.zones.values()]
    expect(zones).toHaveLength(1)
    expect(zones[0].afterLineNumber).toBe(OTHER_LINE)
    expect(draftCard(fake).textarea.value).toBe(BODY)
  })
})

describe('useDiffCommentDraftZone in-flight submit', () => {
  it('does not carry a submitting draft across a model swap and clears it once the save lands', async () => {
    const fake = createFakeDiffCommentEditor()
    const { onCreateComment, settle } = deferredCreateComment()
    const hook = renderDraftZone(fake, onCreateComment)
    openDraftAt(hook, DRAFT_LINE)
    submitDraft(fake, BODY)
    expect(onCreateComment).toHaveBeenCalledTimes(1)

    hook.rerender({ monacoModelIdentity: 'model-v2' })
    pumpFrames()
    // The in-flight save owns the text: no replacement card that could submit it a second time.
    expect(fake.zones.size).toBe(0)

    await settle(true)
    pumpFrames()
    expect(fake.zones.size).toBe(0)
    expect(hook.result.current.isDraftOpen()).toBe(false)
    expect(onCreateComment).toHaveBeenCalledTimes(1)
  })

  it('brings the draft back for retry when its save fails after a model swap', async () => {
    const fake = createFakeDiffCommentEditor()
    const { onCreateComment, settle } = deferredCreateComment()
    const hook = renderDraftZone(fake, onCreateComment)
    openDraftAt(hook, DRAFT_LINE)
    submitDraft(fake, BODY)
    hook.rerender({ monacoModelIdentity: 'model-v2' })
    expect(fake.zones.size).toBe(0)

    await settle(false)

    const { textarea } = draftCard(fake)
    expect(textarea.value).toBe(BODY)
    expect([...fake.zones.values()][0].afterLineNumber).toBe(DRAFT_LINE)
    expect(hook.result.current.isDraftOpen()).toBe(true)
  })

  it('does not carry a submitting body into a draft opened on another line', async () => {
    const fake = createFakeDiffCommentEditor()
    const { onCreateComment, settle } = deferredCreateComment()
    const hook = renderDraftZone(fake, onCreateComment)
    openDraftAt(hook, DRAFT_LINE)
    submitDraft(fake, BODY)

    openDraftAt(hook, OTHER_LINE)
    expect(draftCard(fake).textarea.value).toBe('')

    await settle(true)
    const zones = [...fake.zones.values()]
    expect(zones).toHaveLength(1)
    expect(zones[0].afterLineNumber).toBe(OTHER_LINE)
    expect(onCreateComment).toHaveBeenCalledTimes(1)
  })
})

describe('useDiffCommentDraftZone focus handoff', () => {
  it('returns focus to the editor when a save succeeds while the card holds it', async () => {
    const fake = createFakeDiffCommentEditor()
    const { onCreateComment, settle } = deferredCreateComment()
    const hook = renderDraftZone(fake, onCreateComment)
    openDraftAt(hook, DRAFT_LINE)
    draftCard(fake).textarea.focus()
    submitDraft(fake, BODY)

    await settle(true)

    expect(fake.zones.size).toBe(0)
    expect(fake.focusCount()).toBe(1)
  })

  it('returns focus to the editor when the save was started from the submit button', async () => {
    const fake = createFakeDiffCommentEditor()
    const { onCreateComment, settle } = deferredCreateComment()
    const hook = renderDraftZone(fake, onCreateComment)
    openDraftAt(hook, DRAFT_LINE)
    typeDraft(fake, BODY)
    const submit = within(draftCard(fake).dom).getByRole('button', { name: 'Add note' })
    submit.focus()
    fireEvent.click(submit)
    // The card must still hold focus while the save is pending, on a control that stays enabled.
    expect(document.activeElement).toBe(draftCard(fake).textarea)

    await settle(true)

    expect(fake.zones.size).toBe(0)
    expect(fake.focusCount()).toBe(1)
  })

  it('leaves focus alone when the save settles after the user clicked away', async () => {
    const fake = createFakeDiffCommentEditor()
    const { onCreateComment, settle } = deferredCreateComment()
    const hook = renderDraftZone(fake, onCreateComment)
    openDraftAt(hook, DRAFT_LINE)
    submitDraft(fake, BODY)

    const elsewhere = document.createElement('input')
    document.body.appendChild(elsewhere)
    elsewhere.focus()
    await settle(true)

    expect(fake.zones.size).toBe(0)
    expect(fake.focusCount()).toBe(0)
  })
})

describe('useDiffCommentDraftZone open state', () => {
  it('reports the draft closed again after cancel so the chord is not deadened', () => {
    const fake = createFakeDiffCommentEditor()
    const hook = renderDraftZone(fake, vi.fn().mockResolvedValue(true))
    openDraftAt(hook, DRAFT_LINE)
    expect(hook.result.current.isDraftOpen()).toBe(true)

    fireEvent.click(within(draftCard(fake).dom).getByRole('button', { name: 'Cancel' }))

    expect(hook.result.current.isDraftOpen()).toBe(false)
    expect(fake.zones.size).toBe(0)

    openDraftAt(hook, OTHER_LINE)
    expect(hook.result.current.isDraftOpen()).toBe(true)
    expect([...fake.zones.values()][0].afterLineNumber).toBe(OTHER_LINE)
  })
})

describe('useDiffCommentDraftZone teardown', () => {
  it('does not resurrect a card when a failed save settles after unmount', async () => {
    const fake = createFakeDiffCommentEditor()
    const { onCreateComment, settle } = deferredCreateComment()
    const hook = renderDraftZone(fake, onCreateComment)
    openDraftAt(hook, DRAFT_LINE)
    submitDraft(fake, BODY)

    hook.unmount()
    expect(fake.zones.size).toBe(0)

    await settle(false)
    pumpFrames()
    expect(fake.zones.size).toBe(0)
  })
})
