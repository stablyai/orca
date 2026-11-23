// @vitest-environment happy-dom
import { createRef } from 'react'
import { act, cleanup, render, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { JSONContent } from '@tiptap/react'
import { NativeChatPromptEditor } from './NativeChatPromptEditor'
import type { NativeChatComposerInput } from './native-chat-composer-input'
import { promptEditor } from './native-chat-prompt-editor.test-support'
import { restorePromptBotMentions } from './native-chat-prompt-document-text'
import {
  createMemoryNativeChatComposerDraftStorage,
  setNativeChatComposerDraftStorageForTests
} from '../../drafts/native-chat-composer-draft-storage'
import { hydrateNativeChatComposerDrafts } from '../../drafts/native-chat-composer-draft-load'
import { clearNativeChatComposerDraftsForTests } from '../../drafts/native-chat-draft-reset'
import { writeNativeChatDraftDocument } from '../../drafts/native-chat-draft-views'
import { nativeChatComposerDraftWriteSettled } from '../../drafts/native-chat-composer-draft-persistence'
import { serializeNativeChatAgentReferences } from '../pickers/native-chat-agent-reference-send'

const SCOPE = 'agent-session:legacy-bot'
const TEXT =
  'ask [Bot: Original](bot:stable-id) [Bot: Original](bot-chat:stable-id/chat-1) $review @/repo/note.txt [Image](orca-image:image-1) @Worker (Orca agent term_abc) [Bot: broken](bot:bad/id) [Bot: elsewhere](custom:foo)'
// Loading moves the legacy image chip and its token out of the prompt; the image stays attached.
const MIGRATED = TEXT.replace('[Image](orca-image:image-1) ', '')
const SENT =
  'ask [Bot: Original](bot:stable-id) [Bot: Original](bot-chat:stable-id/chat-1) $review @/repo/note.txt @Worker [Bot: broken](bot:bad/id) [Bot: elsewhere](custom:foo)\n\n[Orca agent "Worker": term_abc — message it with orca orchestration send --to term_abc --subject "<topic>" --body "<message>"]'
const SKILL = { type: 'nativeChatSkill', attrs: { token: '$review', path: '/repo/SKILL.md' } }
const FILE = {
  type: 'nativeChatFileReference',
  attrs: { token: '@/repo/note.txt', path: '/repo/note.txt' }
}
const IMAGE = { type: 'nativeChatImageReference', attrs: { attachmentId: 'image-1' } }
const AGENT = {
  type: 'nativeChatAgentReference',
  attrs: { label: 'Worker', address: 'term_abc', hostKey: 'local' }
}
const TAIL = ' [Bot: broken](bot:bad/id) [Bot: elsewhere](custom:foo)'
const LEGACY: JSONContent = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'ask [Bot: Original](bot:stable-id) [Bot: Original](bot-chat:stable-id/chat-1) '
        },
        SKILL,
        { type: 'text', text: ' ' },
        FILE,
        { type: 'text', text: ' ' },
        IMAGE,
        { type: 'text', text: ' ' },
        AGENT,
        { type: 'text', text: TAIL }
      ]
    }
  ]
}
const UPGRADED: JSONContent = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'ask ' },
        {
          type: 'nativeChatBotMention',
          attrs: { id: 'stable-id', name: 'Original', chatId: '', server: '' }
        },
        { type: 'text', text: ' ' },
        {
          type: 'nativeChatBotMention',
          attrs: { id: 'stable-id', name: 'Original', chatId: 'chat-1', server: '' }
        },
        { type: 'text', text: ' ' },
        SKILL,
        { type: 'text', text: ' ' },
        FILE,
        { type: 'text', text: ' ' },
        { ...AGENT, attrs: { ...AGENT.attrs, agentType: '' } },
        { type: 'text', text: TAIL }
      ]
    }
  ]
}

const storage = createMemoryNativeChatComposerDraftStorage()

beforeEach(async () => {
  clearNativeChatComposerDraftsForTests()
  storage.drafts.clear()
  storage.drafts.set(SCOPE, {
    text: TEXT,
    document: LEGACY,
    images: [{ id: 'image-1', path: '/repo/image.png' }],
    savedAt: 1
  })
  setNativeChatComposerDraftStorageForTests(storage)
  await hydrateNativeChatComposerDrafts()
})

afterEach(() => {
  cleanup()
  clearNativeChatComposerDraftsForTests()
})

function mount(value: string) {
  const inputRef = createRef<NativeChatComposerInput>()
  const view = render(
    <NativeChatPromptEditor
      scopeKey={SCOPE}
      inputRef={inputRef}
      initialValue={value}
      disabled={false}
      placeholder="Message"
      onChange={vi.fn()}
      onSelect={vi.fn()}
    />
  )
  return {
    ...view,
    input: inputRef.current!,
    editor: promptEditor(within(view.container).getByRole('textbox'))
  }
}

it.each(['mount', 'adopt'])(
  'upgrades a saved legacy draft on %s without changing its send text',
  async (load) => {
    const first = mount(load === 'mount' ? MIGRATED : 'earlier draft')
    if (load === 'adopt') {
      act(() => {
        first.input.value = MIGRATED
      })
    }
    expect(first.editor.getJSON()).toEqual(UPGRADED)
    expect(first.input.value).toBe(MIGRATED)
    expect(serializeNativeChatAgentReferences(first.input.value, first.editor.getJSON())).toBe(SENT)

    act(() => writeNativeChatDraftDocument(SCOPE, MIGRATED, first.editor.getJSON()))
    first.unmount()
    await nativeChatComposerDraftWriteSettled(SCOPE)
    expect(storage.drafts.get(SCOPE)?.text).toBe(MIGRATED)
    expect(storage.drafts.get(SCOPE)?.document).toEqual(UPGRADED)
    expect(storage.drafts.get(SCOPE)?.images).toEqual([{ id: 'image-1', path: '/repo/image.png' }])
    clearNativeChatComposerDraftsForTests()
    setNativeChatComposerDraftStorageForTests(storage)
    await hydrateNativeChatComposerDrafts()

    const second = mount(MIGRATED)
    expect(second.editor.getJSON()).toEqual(UPGRADED)
    expect(second.input.value).toBe(MIGRATED)
    expect(serializeNativeChatAgentReferences(second.input.value, second.editor.getJSON())).toBe(
      SENT
    )
  }
)

it('leaves unknown blocks and malformed tokens intact and is idempotent on an upgraded document', () => {
  const document: JSONContent = {
    type: 'doc',
    content: [
      { type: 'futureBlock', content: [{ type: 'text', text: '[Bot: Original](bot:stable-id)' }] },
      { type: 'paragraph', content: [{ type: 'text', text: TAIL }] }
    ]
  }
  expect(restorePromptBotMentions(document)).toEqual(document)
  expect(restorePromptBotMentions(UPGRADED)).toEqual(UPGRADED)
})
