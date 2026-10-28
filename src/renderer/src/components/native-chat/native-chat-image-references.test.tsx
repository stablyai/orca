// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { useRef, type RefObject } from 'react'
import type { JSONContent } from '@tiptap/react'
import { NativeChatPromptEditor } from './NativeChatPromptEditor'
import type { NativeChatComposerInput } from './native-chat-composer-input'
import {
  clearNativeChatAttachmentCacheForTests,
  useNativeChatComposerAttachments
} from './use-native-chat-composer-attachments'
import {
  readNativeChatComposerDraft,
  structuredAgentSessionDraftScopeKey,
  updateNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import { handBackStructuredAgentSessionMessage } from './structured-agent-session-message-hand-back'
import { dispatchNativeChatStructuredComposerText } from './native-chat-structured-composer-dispatch'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import { fileReferenceContent, promptTextContent } from './native-chat-prompt-document'
import { writeNativeChatDraftCache } from './native-chat-draft-cache'
import { nativeChatComposerDraftLeftAfterSend } from './native-chat-composer-draft-comparison'
import { withNativeChatComposerDraftAddition } from './native-chat-composer-draft-addition'
import { formatNativeChatFileReference } from '../../../../shared/agent-image-paste'
import { promptEditor, promptValue } from './native-chat-prompt-editor.test-support'
import { imageReferenceToken as chip } from '../../../../shared/native-chat-image-reference'
import { imageReferencesToPromptMarkers } from '../../../../shared/native-chat-image-transcript-markers'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(values?.[name]))
}))

type Api = ReturnType<typeof useNativeChatComposerAttachments>

/** The composer's shape: one editor, keyed by the conversation it shows, numbered by its row. */
function Composer({
  scopeKey,
  onApi
}: {
  scopeKey: string
  onApi: (api: Api, input: RefObject<NativeChatComposerInput | null>) => void
}) {
  const inputRef = useRef<NativeChatComposerInput>(null)
  const api = useNativeChatComposerAttachments({
    attachmentScopeKey: scopeKey,
    allowWithoutTarget: true,
    imageReferences: true,
    caret: 0,
    disabled: false,
    isComposing: () => false,
    resolveTarget: () => null,
    textareaRef: inputRef,
    setCaret: () => {},
    setDraft: () => {},
    setNotice: () => {}
  })
  onApi(api, inputRef)
  return (
    <NativeChatPromptEditor
      key={scopeKey}
      scopeKey={scopeKey}
      imageRow={api.imageAttachments.map(({ id }) => id)}
      inputRef={inputRef}
      initialValue={readNativeChatComposerDraft(scopeKey).text}
      disabled={false}
      placeholder="Message"
      onChange={() => {}}
      onSelect={() => {}}
    />
  )
}

function renderComposer(scopeKey: string) {
  const seen: { api?: Api; input?: RefObject<NativeChatComposerInput | null> } = {}
  const onApi = (api: Api, input: RefObject<NativeChatComposerInput | null>): void => {
    seen.api = api
    seen.input = input
  }
  const view = render(<Composer scopeKey={scopeKey} onApi={onApi} />)
  const textbox = (): HTMLElement => view.getByRole('textbox')
  return {
    view,
    api: () => seen.api!,
    input: () => seen.input!.current!,
    textbox,
    chips: () =>
      [...view.container.querySelectorAll('[data-native-chat-image-reference]')].map(
        (pill) => pill.textContent
      ),
    show: (next: string) => view.rerender(<Composer scopeKey={next} onApi={onApi} />)
  }
}

function begin(composer: ReturnType<typeof renderComposer>, name?: string): string {
  let id: string | null = null
  act(() => {
    id = composer.api().beginPendingImageAttachment(undefined, name)
  })
  if (!id) {
    throw new Error('expected a pending image')
  }
  return id
}

function message(text: string, paths: string[]) {
  return {
    kind: 'message' as const,
    role: 'user' as const,
    blocks: [
      { type: 'text' as const, text },
      ...paths.map((path) => ({ type: 'image-ref' as const, path }))
    ]
  }
}

function fileReferences(document: JSONContent | undefined): string[] {
  return (document?.content ?? []).flatMap((block) =>
    (block.content ?? []).flatMap((node) =>
      node.type === 'nativeChatFileReference' ? [String(node.attrs?.path)] : []
    )
  )
}

function transport(send: NativeChatStructuredComposerTransport['send']) {
  const value: NativeChatStructuredComposerTransport = {
    capturePresentation: () => () => true,
    send,
    dispatchCommand: async () => ({ handled: false, accepted: false, error: null }),
    optionsSurface: {
      getSnapshot: () => [],
      setOption: vi.fn(),
      invokeAction: vi.fn(),
      subscribe: () => () => {}
    },
    optionSnapshot: [],
    onError: vi.fn(),
    runtime: 'local',
    sessionId: 's1',
    runtimeEnvironmentId: null
  }
  return value
}

afterEach(() => {
  cleanup()
  clearNativeChatAttachmentCacheForTests()
})

describe('composer image chips', () => {
  it('numbers chips by the thumbnail row and renumbers them when a thumbnail goes, with no text edit', async () => {
    const composer = renderComposer('tab-1:pane')
    act(() => promptEditor(composer.textbox()).commands.focus('end'))
    const first = begin(composer)
    const second = begin(composer)
    const text = promptValue(composer.textbox())
    await waitFor(() => expect(composer.chips()).toEqual(['Image #1', 'Image #2']))

    act(() => composer.api().removeImageAttachment(first))

    await waitFor(() => expect(composer.chips()).toEqual(['Image #1']))
    expect(promptValue(composer.textbox())).toBe(text.replace(`${chip(first)} `, ''))
    expect(promptValue(composer.textbox())).toContain(chip(second))
  })

  it('removes every chip of a removed thumbnail, and keeps the thumbnail when a chip is deleted', async () => {
    const composer = renderComposer('tab-1:pane')
    const kept = begin(composer)
    const removed = begin(composer)
    act(() => {
      promptEditor(composer.textbox()).commands.insertContent({
        type: 'nativeChatImageReference',
        attrs: { attachmentId: removed }
      })
    })
    await waitFor(() => expect(composer.chips()).toHaveLength(3))

    act(() => composer.api().removeImageAttachment(removed))
    await waitFor(() => expect(composer.chips()).toEqual(['Image #1']))

    act(() => promptEditor(composer.textbox()).commands.setContent({ type: 'doc', content: [] }))
    expect(composer.api().imageAttachments.map(({ id }) => id)).toEqual([kept])
  })

  it('takes a failed upload’s chip from its own conversation while another is shown', () => {
    updateNativeChatComposerDraft('chat-b', { text: 'B draft' }, 'immediate')
    const composer = renderComposer('chat-a')
    const failed = begin(composer)
    const fromA = composer.api()
    composer.show('chat-b')

    act(() => {
      fromA.dropPendingImageAttachment(failed)
    })

    expect(promptValue(composer.textbox())).toBe('B draft')
    expect(readNativeChatComposerDraft('chat-b').text).toBe('B draft')
    expect(readNativeChatComposerDraft('chat-a').text).toBe('')
  })

  it('gives a message returned while an image uploads distinct, correct numbers at send', () => {
    const scope = structuredAgentSessionDraftScopeKey('s1')
    const composer = renderComposer(scope)
    const uploading = begin(composer)
    act(() => {
      handBackStructuredAgentSessionMessage(
        's1',
        'm1',
        message('compare [Image #1] with [Image #2]', ['/up/a.png', '/up/b.png'])
      )
    })
    act(() => composer.api().resolvePendingImageAttachment(uploading, '/up/new.png'))

    const sent = composer.api().imageAttachments
    expect(sent.map(({ path }) => path)).toEqual(['/up/a.png', '/up/b.png', '/up/new.png'])
    expect(
      imageReferencesToPromptMarkers(
        readNativeChatComposerDraft(scope).text,
        sent.map(({ id }) => id)
      )
    ).toBe('[Image #3]\n\ncompare [Image #1] with [Image #2]')
  })

  it('sends no marker for an image lost in a crash', async () => {
    const send = vi.fn(() => true)
    await dispatchNativeChatStructuredComposerText(transport(send), `see ${chip('lost')}`, [
      { id: 'kept', path: '/up/kept.png' }
    ])
    expect(send).toHaveBeenCalledWith('see ', [{ id: 'kept', path: '/up/kept.png' }])
  })

  it('never touches a file pill named like a marker, in the editor or a stored draft', () => {
    const pill = '/tmp/[Image #2].md'
    const composer = renderComposer('chat-a')
    const shown = begin(composer)
    act(() => {
      promptEditor(composer.textbox()).commands.insertContent([fileReferenceContent(pill)])
    })
    const hidden = begin(composer)
    const fromA = composer.api()
    act(() => fromA.removeImageAttachment(shown))
    expect(promptValue(composer.textbox())).toContain(formatNativeChatFileReference(pill))

    composer.show('chat-b')
    act(() => {
      fromA.dropPendingImageAttachment(hidden)
    })
    const stored = readNativeChatComposerDraft('chat-a')
    expect(stored.text).toBe(`${formatNativeChatFileReference(pill)} `)
    expect(fileReferences(stored.document)).toEqual([pill])
  })

  it('keeps one chip bound to an unavailable image attached again while it uploads', async () => {
    updateNativeChatComposerDraft(
      'tab-1:pane',
      {
        text: `look ${chip('missing')}`,
        images: [{ id: 'missing', path: '', unavailableName: 'shot.png' }]
      },
      'immediate'
    )
    const composer = renderComposer('tab-1:pane')
    const upload = begin(composer, 'shot.png')
    act(() => composer.api().resolvePendingImageAttachment(upload, '/up/shot.png'))

    expect(composer.api().imageAttachments).toMatchObject([{ id: 'missing', path: '/up/shot.png' }])
    await waitFor(() => expect(composer.chips()).toEqual(['Image #1']))
    expect(promptValue(composer.textbox())).toBe(`look ${chip('missing')}`)
  })

  it('leaves a file path that reads like a marker as typed when a message comes back', () => {
    const scope = structuredAgentSessionDraftScopeKey('s1')
    const file = formatNativeChatFileReference('/repo/[Image #1].md')
    handBackStructuredAgentSessionMessage(
      's1',
      'm1',
      message(`see ${file} and [Image #1]`, ['/up/a.png'])
    )
    expect(readNativeChatComposerDraft(scope).text).toBe(`see ${file} and ${chip('returned-m1-1')}`)
  })

  it('adds a message recovered twice once', () => {
    const scope = structuredAgentSessionDraftScopeKey('s1')
    const returned = message('see [Image #1]', ['/up/a.png'])
    handBackStructuredAgentSessionMessage('s1', 'm1', returned)
    handBackStructuredAgentSessionMessage('s1', 'm1', returned)
    expect(readNativeChatComposerDraft(scope)).toMatchObject({
      text: `see ${chip('returned-m1-1')}`,
      images: [{ id: 'returned-m1-1', path: '/up/a.png' }]
    })
  })

  it('keeps a stored draft’s file reference when a message comes back', async () => {
    const scope = structuredAgentSessionDraftScopeKey('s1')
    const composer = renderComposer(scope)
    act(() => {
      promptEditor(composer.textbox()).commands.insertContent([fileReferenceContent('/repo/a.md')])
    })
    cleanup()
    handBackStructuredAgentSessionMessage('s1', 'm1', message('see [Image #1]', ['/up/a.png']))

    const back = renderComposer(scope)
    expect(fileReferences(readNativeChatComposerDraft(scope).document)).toEqual(['/repo/a.md'])
    await waitFor(() => expect(back.chips()).toEqual(['Image #1']))
  })

  it('rebuilds chips with their ids from text: a reload, a journal replay, a whole-text update', async () => {
    const scope = 'tab-1:pane'
    const imageIds = (document: JSONContent | undefined): string[] =>
      (document?.content ?? []).flatMap((block) =>
        (block.content ?? []).flatMap((node) =>
          node.type === 'nativeChatImageReference' ? [String(node.attrs?.attachmentId)] : []
        )
      )
    // A save keeps the text alone; the editor rebuilds the chip from its token.
    writeNativeChatDraftCache(scope, `see ${chip('a')}`)
    const composer = renderComposer(scope)
    await waitFor(() => expect(composer.chips()).toEqual(['Image removed']))
    expect(imageIds(promptEditor(composer.textbox()).getJSON())).toEqual(['a'])

    // A hidden composer's update, an IME settle and a sent draft's leftover all set the text whole.
    act(() => {
      composer.input().value = `${chip('a')} typed ${chip('b')}`
    })
    expect(imageIds(promptEditor(composer.textbox()).getJSON())).toEqual(['a', 'b'])
    const sent = { text: `${chip('a')} `, images: [] }
    expect(
      nativeChatComposerDraftLeftAfterSend({ text: `${chip('a')} ${chip('b')}`, images: [] }, sent)
        ?.text
    ).toBe(chip('b'))

    // A journal replay appends to the saved document without losing its chips.
    const text = `${chip('a')} typed ${chip('b')}`
    const replayed = withNativeChatComposerDraftAddition(
      { text, document: promptTextContent(text), images: [] },
      { text: `back ${chip('c')}` }
    )
    expect(imageIds(replayed.document)).toEqual(['a', 'b', 'c'])
  })

  it('adds a returned message once even after typing, by its image ids', () => {
    const scope = structuredAgentSessionDraftScopeKey('s1')
    const returned = message('see [Image #1]', ['/up/a.png'])
    handBackStructuredAgentSessionMessage('s1', 'm1', returned)
    updateNativeChatComposerDraft(
      scope,
      { text: `${readNativeChatComposerDraft(scope).text} and more` },
      'immediate'
    )
    handBackStructuredAgentSessionMessage('s1', 'm1', returned)
    expect(readNativeChatComposerDraft(scope)).toMatchObject({
      text: `see ${chip('returned-m1-1')} and more`,
      images: [{ id: 'returned-m1-1' }]
    })
  })

  it('numbers a send against exactly the images sent with it, not the live row', async () => {
    const send = vi.fn(() => true)
    await dispatchNativeChatStructuredComposerText(
      transport(send),
      `${chip('later')} see ${chip('sent')}`,
      [{ id: 'sent', path: '/up/sent.png' }]
    )
    expect(send).toHaveBeenCalledWith(' see [Image #1]', [{ id: 'sent', path: '/up/sent.png' }])
  })

  it('shows a chip whose image is not in the row as removed', async () => {
    updateNativeChatComposerDraft(
      'tab-1:pane',
      { text: `undo brought ${chip('gone')}` },
      'immediate'
    )
    const composer = renderComposer('tab-1:pane')
    await waitFor(() => expect(composer.chips()).toEqual(['Image removed']))
  })

  it('settles a late upload into its own conversation, bound by the same id, while another is shown', async () => {
    updateNativeChatComposerDraft('chat-b', { text: 'B draft' }, 'immediate')
    const composer = renderComposer('chat-a')
    const upload = begin(composer)
    const fromA = composer.api()
    composer.show('chat-b')

    act(() => fromA.resolvePendingImageAttachment(upload, '/up/a.png'))

    expect(readNativeChatComposerDraft('chat-a')).toMatchObject({
      text: `${chip(upload)} `,
      images: [{ id: upload, path: '/up/a.png' }]
    })
    expect(promptValue(composer.textbox())).toBe('B draft')
  })
})
