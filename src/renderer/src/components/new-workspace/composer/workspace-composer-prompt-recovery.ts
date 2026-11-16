import {
  appendToNativeChatComposerDraft,
  readNativeChatComposerDraft
} from '@/components/native-chat/drafts/native-chat-composer-draft-store'

export const WORKSPACE_CREATION_PROMPT_SCOPE_KEY = 'new-workspace-composer:prompt'

export function captureWorkspaceComposerPromptRecovery(): () => void {
  const submitted = readNativeChatComposerDraft(WORKSPACE_CREATION_PROMPT_SCOPE_KEY)
  return () => {
    appendToNativeChatComposerDraft(WORKSPACE_CREATION_PROMPT_SCOPE_KEY, submitted)
  }
}
