// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest'
import {
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from '@/components/native-chat/drafts/native-chat-composer-draft-store'
import {
  captureWorkspaceComposerPromptRecovery,
  WORKSPACE_CREATION_PROMPT_SCOPE_KEY
} from './workspace-composer-prompt-recovery'

function write(text: string): void {
  updateNativeChatComposerDraft(
    WORKSPACE_CREATION_PROMPT_SCOPE_KEY,
    { text, images: [], document: undefined },
    'immediate'
  )
}

afterEach(() => write(''))

it('restores a submitted prompt after launch preparation fails', () => {
  write('Fix the checkout')
  const reopen = captureWorkspaceComposerPromptRecovery()
  write('')
  reopen()
  expect(readNativeChatComposerDraft(WORKSPACE_CREATION_PROMPT_SCOPE_KEY).text).toBe(
    'Fix the checkout'
  )
})

it('keeps newer text when restoring the failed submission', () => {
  write('Fix the checkout')
  const reopen = captureWorkspaceComposerPromptRecovery()
  write('Review the migration')
  reopen()
  expect(readNativeChatComposerDraft(WORKSPACE_CREATION_PROMPT_SCOPE_KEY).text).toBe(
    'Review the migration\n\nFix the checkout'
  )
})
