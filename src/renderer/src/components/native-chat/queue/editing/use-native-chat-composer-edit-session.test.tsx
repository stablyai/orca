// @vitest-environment happy-dom
import { useRef } from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { captureInsertionTarget, insertText } from '../../../dictation/dictation-insertion-target'
import { clearNativeChatComposerDraftsForTests } from '../../drafts/native-chat-draft-reset'
import { readNativeChatComposerDraft } from '../../drafts/native-chat-composer-draft-store'
import { hydrateNativeChatComposerDrafts } from '../../drafts/native-chat-composer-draft-load'
import {
  createMemoryNativeChatComposerDraftStorage,
  setNativeChatComposerDraftStorageForTests
} from '../../drafts/native-chat-composer-draft-storage'
import type { NativeChatComposerHandle } from '../../composer/native-chat-composer-types'
import { useNativeChatComposerEditSession } from './use-native-chat-composer-edit-session'

const scope = 'agent-session:dictation'

function Composer() {
  const root = useRef<HTMLDivElement>(null)
  const handle = useRef<NativeChatComposerHandle>(null)
  useNativeChatComposerEditSession({
    editSession: undefined,
    root,
    handle,
    ref: null,
    draftScopeKey: scope,
    agent: 'codex',
    structuredTransport: undefined,
    sendStructured: () => {},
    ptyCommandRouting: {
      agent: 'codex',
      disabled: false,
      isDispatchingSessionOption: false,
      resolveTarget: () => null,
      sessionOptionsSurface: null,
      trackPendingSend: () => {},
      setDraft: () => {},
      setCaret: () => {},
      setActiveSuggestion: () => {},
      clearSkillOrigin: () => {},
      clearImageAttachments: () => {},
      setNotice: () => {}
    },
    setNotice: () => {},
    disabled: false,
    sendHeld: false,
    sendMessage: () => {},
    completeItem: () => {}
  })
  return (
    <div ref={root}>
      <textarea aria-label="Prompt" />
      <button type="button">Stop dictation</button>
    </div>
  )
}

beforeEach(async () => {
  clearNativeChatComposerDraftsForTests()
  setNativeChatComposerDraftStorageForTests(createMemoryNativeChatComposerDraftStorage())
  await hydrateNativeChatComposerDrafts()
})
afterEach(() => {
  cleanup()
  clearNativeChatComposerDraftsForTests()
})

it('lands late dictation in the composer draft after a click moved focus to its stop button', () => {
  render(<Composer />)
  screen.getByRole('textbox', { name: 'Prompt' }).focus()
  const target = captureInsertionTarget()
  if (!target) {
    throw new Error('missing captured target')
  }
  screen.getByRole('button', { name: 'Stop dictation' }).focus()
  act(() => void insertText('dictated words', target))
  act(() => void insertText(' and more', target))
  expect(readNativeChatComposerDraft(scope).text).toBe('dictated words and more')
})
