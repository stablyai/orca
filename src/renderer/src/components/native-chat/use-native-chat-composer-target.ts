import { useCallback } from 'react'
import { getSettingsForAgentTabRuntimeOwner } from '@/lib/agent-paste-draft'
import type { NativeChatResolvedTarget } from './native-chat-composer-target'

export function useNativeChatComposerTarget(
  terminalTabId: string,
  targetPtyId: string | null,
  canSend: boolean,
  setCaret: (caret: number | ((previous: number) => number)) => void
): {
  resolveTarget: () => NativeChatResolvedTarget | null
  hasPty: boolean
  disabled: boolean
  syncCaret: (element: HTMLTextAreaElement) => void
} {
  const resolveTarget = useCallback((): NativeChatResolvedTarget | null => {
    if (!targetPtyId) {
      return null
    }
    return { ptyId: targetPtyId, settings: getSettingsForAgentTabRuntimeOwner(terminalTabId) }
  }, [targetPtyId, terminalTabId])
  const syncCaret = useCallback(
    (element: HTMLTextAreaElement) => setCaret(element.selectionStart ?? element.value.length),
    [setCaret]
  )
  return {
    resolveTarget,
    hasPty: targetPtyId !== null,
    disabled: targetPtyId === null || !canSend,
    syncCaret
  }
}
