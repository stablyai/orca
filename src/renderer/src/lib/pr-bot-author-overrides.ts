import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { createBotAuthorOverrideSet, normalizePRCommentAuthorLogin } from './pr-comment-audience'

/** Normalized lookup of author logins the user manually marked as bots. */
export function usePRBotAuthorOverrides(): ReadonlySet<string> {
  const overrides = useAppStore((s) => s.settings?.prBotAuthorOverrides)
  return useMemo(() => createBotAuthorOverrideSet(overrides), [overrides])
}

/** Adds or removes a manual bot override for the given comment author. */
export function setPRBotAuthorOverride(author: string, isBot: boolean): void {
  const { settings, updateSettings } = useAppStore.getState()
  const normalized = normalizePRCommentAuthorLogin(author)
  if (!normalized) {
    return
  }
  const current = createBotAuthorOverrideSet(settings?.prBotAuthorOverrides)
  if (current.has(normalized) === isBot) {
    return
  }
  const next = new Set(current)
  if (isBot) {
    next.add(normalized)
  } else {
    next.delete(normalized)
  }
  void updateSettings({ prBotAuthorOverrides: [...next].sort() })
}
