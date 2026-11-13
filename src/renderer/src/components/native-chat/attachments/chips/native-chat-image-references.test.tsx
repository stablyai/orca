// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { useRef, type RefObject } from 'react'
import type { JSONContent } from '@tiptap/react'
import { NativeChatPromptEditor } from '../../composer/editor/NativeChatPromptEditor'
import type { NativeChatComposerInput } from '../../composer/editor/native-chat-composer-input'
import { clearNativeChatAttachmentCacheForTests } from '../../drafts/native-chat-draft-reset'
import { useNativeChatComposerAttachments } from './use-native-chat-composer-attachments'
import {
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from '../../drafts/native-chat-composer-draft-store'
import { structuredAgentSessionDraftScopeKey } from '../../drafts/native-chat-draft-scope'
import { handBackStructuredAgentSessionMessage } from '../../session/structured/delivery/structured-agent-session-message-hand-back'

import { fileReferenceContent } from '../../composer/editor/native-chat-prompt-document'

import { formatNativeChatFileReference } from '../../../../../../shared/agent-image-paste'
import {
  promptEditor,
  promptValue
} from '../../composer/editor/native-chat-prompt-editor.test-support'
import { imageReferenceToken as chip } from '../../../../../../shared/native-chat/native-chat-image-reference'

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

afterEach(() => {
  cleanup()
  clearNativeChatAttachmentCacheForTests()
})

describe('composer image chips', () => {
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
