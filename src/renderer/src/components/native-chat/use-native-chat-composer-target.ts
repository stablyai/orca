import { useCallback } from 'react'

export function useNativeChatComposerTarget(targetPtyId: string | null) {
  return useCallback(() => (targetPtyId ? { ptyId: targetPtyId } : null), [targetPtyId])
}
