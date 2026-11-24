// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  createMemoryNativeChatComposerDraftStorage,
  setNativeChatComposerDraftStorageForTests
} from '../native-chat/drafts/native-chat-composer-draft-storage'
import {
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from '../native-chat/drafts/native-chat-composer-draft-store'
import { hydrateNativeChatComposerDrafts } from '../native-chat/drafts/native-chat-composer-draft-load'
import { clearNativeChatComposerDraftsForTests } from '../native-chat/drafts/native-chat-draft-reset'
import { structuredAgentSessionDraftScopeKey } from '../native-chat/drafts/native-chat-draft-scope'
import { prepareHandoffDraft } from './open-commander-chat'

const sessionId = 'handoff-chat'
const scope = structuredAgentSessionDraftScopeKey(sessionId)
const owner = { workspaceId: 'checkout', executionHostId: 'runtime:office' } as const

beforeEach(async () => {
  setNativeChatComposerDraftStorageForTests(createMemoryNativeChatComposerDraftStorage())
  await hydrateNativeChatComposerDrafts()
})

afterEach(clearNativeChatComposerDraftsForTests)

it('appends a handoff once and preserves edits and attachments on retry', () => {
  const images = [{ id: 'screen', path: '/screen.png' }]
  updateNativeChatComposerDraft(scope, { text: 'My question', images, owner }, 'immediate')
  const prepare = () => prepareHandoffDraft(sessionId, 'Saved next step', owner)
  prepare()()
  const text = 'My question\n\nSaved next step'
  expect(readNativeChatComposerDraft(scope)).toMatchObject({ text, images, owner })
  const edited = `${text}\nConfirm the result.`
  updateNativeChatComposerDraft(scope, { text: edited }, 'immediate')
  prepare()()
  expect(readNativeChatComposerDraft(scope)).toMatchObject({ text: edited, images, owner })
})

it('protects another host’s draft and preserves an unsent slash command', () => {
  updateNativeChatComposerDraft(scope, { text: '/compact', owner }, 'immediate')
  expect(() =>
    prepareHandoffDraft(sessionId, 'Private goal', { ...owner, executionHostId: 'local' })
  ).toThrow(/another workspace/)
  expect(() => prepareHandoffDraft(sessionId, 'Private goal', owner)).toThrow(/unsent command/)
  expect(readNativeChatComposerDraft(scope)).toMatchObject({ text: '/compact', owner })
})
