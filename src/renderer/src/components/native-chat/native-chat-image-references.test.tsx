// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
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
  hydrateNativeChatComposerDrafts,
  structuredAgentSessionDraftScopeKey,
  updateNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import { handBackStructuredAgentSessionMessage } from './structured-agent-session-message-hand-back'
import { dispatchNativeChatStructuredComposerText } from './native-chat-structured-composer-dispatch'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import { fileReferenceContent, promptSkillRefs } from './native-chat-prompt-document'
import { writeNativeChatDraftCache } from './native-chat-draft-cache'
import { formatNativeChatFileReference } from '../../../../shared/agent-image-paste'
import { promptValue } from './native-chat-prompt-editor.test-support'
import { imageReferenceToken as chip } from '../../../../shared/native-chat/native-chat-image-reference'
import { structuredAgentSessionSendBody } from '../../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import {
  createMemoryNativeChatComposerDraftStorage,
  setNativeChatComposerDraftStorageForTests
} from './native-chat-composer-draft-storage'

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
  setNativeChatComposerDraftStorageForTests(null)
})

describe('composer image attachment context', () => {
  it('keeps text and a selected range intact through pending, resolved, failed and removed images', () => {
    updateNativeChatComposerDraft('chat-a', { text: 'before selected after' }, 'immediate')
    const composer = renderComposer('chat-a')
    act(() => composer.input().setSelectionRange(7, 15))
    const selection = () => [composer.input().selectionStart, composer.input().selectionEnd]
    const first = begin(composer)
    const failed = begin(composer)
    act(() => composer.api().resolvePendingImageAttachment(first, '/up/a.png'))
    act(() => composer.api().dropPendingImageAttachment(failed))
    expect(composer.api().imageAttachments.map(({ id }) => id)).toEqual([first])
    expect(promptValue(composer.textbox())).toBe('before selected after')
    expect(selection()).toEqual([7, 15])
    expect(composer.chips()).toEqual([])
    act(() => composer.api().removeImageAttachment(first))
    expect(promptValue(composer.textbox())).toBe('before selected after')
    expect(selection()).toEqual([7, 15])
  })

  it('keeps image order when uploads settle out of order and sends each image once', async () => {
    const composer = renderComposer('chat-a')
    const first = begin(composer)
    const second = begin(composer)
    act(() => composer.api().resolvePendingImageAttachment(second, '/up/b.png'))
    act(() => composer.api().attachResolvedPaths(['/up/c.png']))
    act(() => composer.api().resolvePendingImageAttachment(first, '/up/a.png'))
    const images = composer.api().imageAttachments
    expect(images.map(({ path }) => path)).toEqual(['/up/a.png', '/up/b.png', '/up/c.png'])
    const send = vi.fn(() => true)
    await dispatchNativeChatStructuredComposerText(transport(send), composer.input().value, images)
    expect(send).toHaveBeenCalledWith('', images)
    expect(
      structuredAgentSessionSendBody(
        '',
        images.map((image) => ({ ...image, previewUri: '' }))
      ).blocks
    ).toEqual([
      { type: 'image-ref', path: '/up/a.png' },
      { type: 'image-ref', path: '/up/b.png' },
      { type: 'image-ref', path: '/up/c.png' }
    ])
  })

  it('settles a late upload into its original scope without changing either text draft', () => {
    updateNativeChatComposerDraft('chat-a', { text: 'A draft' }, 'immediate')
    updateNativeChatComposerDraft('chat-b', { text: 'B draft' }, 'immediate')
    const composer = renderComposer('chat-a')
    const upload = begin(composer)
    const fromA = composer.api()
    composer.show('chat-b')
    act(() => fromA.resolvePendingImageAttachment(upload, '/up/a.png'))
    expect(readNativeChatComposerDraft('chat-a')).toMatchObject({
      text: 'A draft',
      images: [{ id: upload, path: '/up/a.png' }]
    })
    expect(promptValue(composer.textbox())).toBe('B draft')
    composer.show('chat-a')
    expect(promptValue(composer.textbox())).toBe('A draft')
    expect(composer.api().imageAttachments.map(({ id }) => id)).toEqual([upload])
    expect(composer.chips()).toEqual([])
  })

  it('keeps literal image references as editable text when restored or pasted', () => {
    const text = `compare [Image #1] with ${chip('typed')}`
    writeNativeChatDraftCache('chat-a', text)
    const composer = renderComposer('chat-a')
    expect(composer.chips()).toEqual([])
    expect(promptValue(composer.textbox())).toBe(text)
    act(() => composer.input().setSelectionRange(text.length, text.length))
    act(() => composer.input().insertText?.(` ${chip('pasted')}`))
    expect(composer.chips()).toEqual([])
    expect(promptValue(composer.textbox())).toBe(`${text} ${chip('pasted')}`)
  })

  it('restores legacy image nodes as a clean draft while retaining picked file and skill nodes', async () => {
    const token = chip('a')
    const file = fileReferenceContent('/repo/a.md')
    const skill = {
      type: 'nativeChatSkill',
      attrs: { token: '$review', path: '/skills/review.md' }
    }
    const storage = createMemoryNativeChatComposerDraftStorage()
    storage.drafts.set('chat-a', {
      text: `look ${token} ${formatNativeChatFileReference('/repo/a.md')} $review [Image #1]`,
      document: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'look ' },
              { type: 'nativeChatImageReference', attrs: { attachmentId: 'a' } },
              { type: 'text', text: ' ' },
              file,
              { type: 'text', text: ' ' },
              skill,
              { type: 'text', text: ' [Image #1]' }
            ]
          }
        ]
      },
      images: [{ id: 'a', path: '/repo/a.png', connectionId: 'server-a' }],
      savedAt: 1
    })
    setNativeChatComposerDraftStorageForTests(storage)
    await hydrateNativeChatComposerDrafts()
    const composer = renderComposer('chat-a')
    expect(composer.chips()).toEqual([])
    expect(promptValue(composer.textbox())).toBe(
      `look ${formatNativeChatFileReference('/repo/a.md')} $review [Image #1]`
    )
    const draft = readNativeChatComposerDraft('chat-a')
    expect(draft.images).toEqual([{ id: 'a', path: '/repo/a.png', connectionId: 'server-a' }])
    expect(fileReferences(draft.document)).toEqual(['/repo/a.md'])
    expect(promptSkillRefs(draft.document)).toEqual([{ name: 'review', path: '/skills/review.md' }])
  })

  it('restores text-only legacy drafts without broken automatic references or lost images', async () => {
    const storage = createMemoryNativeChatComposerDraftStorage()
    storage.drafts.set('chat-a', {
      text: `${chip('a')} look ${chip('gone')} [Image #1]`,
      images: [{ id: 'a', path: '/repo/a.png' }],
      savedAt: 1
    })
    setNativeChatComposerDraftStorageForTests(storage)
    await hydrateNativeChatComposerDrafts()
    expect(readNativeChatComposerDraft('chat-a')).toMatchObject({
      text: 'look [Image #1]',
      images: [{ id: 'a', path: '/repo/a.png' }]
    })
  })

  it('returns text and attachments together exactly once without turning typed labels into chips', () => {
    const scope = structuredAgentSessionDraftScopeKey('s1')
    const returned = message('compare [Image #1] with [Image #2]', ['/up/a.png', '/up/b.png'])
    handBackStructuredAgentSessionMessage('s1', 'm1', returned)
    handBackStructuredAgentSessionMessage('s1', 'm1', returned)
    const composer = renderComposer(scope)
    expect(promptValue(composer.textbox())).toBe('compare [Image #1] with [Image #2]')
    expect(composer.chips()).toEqual([])
    expect(readNativeChatComposerDraft(scope).images.map(({ path }) => path)).toEqual([
      '/up/a.png',
      '/up/b.png'
    ])
  })
})
