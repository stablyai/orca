import { useCallback, useEffect, useState } from 'react'
import { buildSideQuestPrompt, type SideQuestQuotedContext } from '@/lib/side-quest-context'
import {
  clearNativeChatSideQuestContext,
  readNativeChatSideQuestContext
} from './native-chat-side-quest-context-cache'
import { readNativeChatSideQuestReadiness } from './native-chat-side-quest-readiness-cache'

export type NativeChatSideQuestReadiness = 'not-side-quest' | 'starting' | 'ready' | 'failed'

export function useNativeChatSideQuestContext(terminalTabId: string): {
  context: SideQuestQuotedContext | null
  readiness: NativeChatSideQuestReadiness
  clearContext: () => void
  buildSubmittedText: (text: string, isSlashCommand: boolean) => string | null
} {
  const [context, setContext] = useState(() => readNativeChatSideQuestContext(terminalTabId))
  const [readiness, setReadiness] = useState<NativeChatSideQuestReadiness>(() =>
    readNativeChatSideQuestReadiness(terminalTabId) ? 'starting' : 'not-side-quest'
  )

  useEffect(() => {
    const pending = readNativeChatSideQuestReadiness(terminalTabId)
    if (!pending) {
      setReadiness('not-side-quest')
      return
    }
    let active = true
    setReadiness('starting')
    void pending.then((ready) => {
      if (active) {
        setReadiness(ready ? 'ready' : 'failed')
      }
    })
    return () => {
      active = false
    }
  }, [terminalTabId])

  const clearContext = useCallback(() => {
    clearNativeChatSideQuestContext(terminalTabId)
    setContext(null)
  }, [terminalTabId])

  const buildSubmittedText = useCallback(
    (text: string, isSlashCommand: boolean): string | null =>
      !isSlashCommand && context ? buildSideQuestPrompt(text, context) : text,
    [context]
  )

  return { context, readiness, clearContext, buildSubmittedText }
}
