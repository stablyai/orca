import {
  resolveQuickCreatePrompt,
  type QuickCreatePromptInput
} from '@/lib/workspace/creation/quick-create-prompt'

/** Folder workspaces have no comment field, so without linked context the note rides in the prompt. */
export function resolveFolderWorkspaceSubmitPrompt({
  typedPrompt,
  linkedWorkItem,
  note
}: QuickCreatePromptInput): string {
  if (!typedPrompt.trim()) {
    return note
  }
  if (linkedWorkItem) {
    return resolveQuickCreatePrompt({ typedPrompt, linkedWorkItem, note }).prompt
  }
  return [typedPrompt.trim(), note.trim()].filter(Boolean).join('\n\n')
}
