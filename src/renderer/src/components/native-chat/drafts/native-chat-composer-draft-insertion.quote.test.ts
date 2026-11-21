// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest'
import type { JSONContent } from '@tiptap/react'
import { insertNativeChatComposerDraftText } from './native-chat-composer-draft-insertion'
import {
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import { clearNativeChatComposerDraftsForTests } from './native-chat-draft-reset'
import { promptTextContent } from '../composer/editor/native-chat-prompt-document-text'

afterEach(() => clearNativeChatComposerDraftsForTests())

const nodeTypes = (node: JSONContent | undefined): string[] =>
  node ? [node.type ?? '', ...(node.content ?? []).flatMap(nodeTypes)] : []

it('keeps a paste into a hidden chat draft literal, with no quote chip', () => {
  updateNativeChatComposerDraft('hidden-paste', { text: 'hi' }, 'immediate')
  insertNativeChatComposerDraftText('hidden-paste', '\n> x\n\n', { paste: true, draftOnly: true })
  const draft = readNativeChatComposerDraft('hidden-paste')
  expect(draft.text).toBe('hi\n> x\n\n')
  expect(draft.document).toBeDefined()
  expect(nodeTypes(draft.document)).not.toContain('nativeChatQuote')
})

it('makes a quote chip from typed quote text in a hidden chat draft', () => {
  const document = promptTextContent('hi')
  updateNativeChatComposerDraft('hidden-typed', { text: 'hi', document }, 'immediate')
  insertNativeChatComposerDraftText('hidden-typed', '\n> x\n\n', { draftOnly: true })
  expect(nodeTypes(readNativeChatComposerDraft('hidden-typed').document)).toContain(
    'nativeChatQuote'
  )
})
