import { useCallback, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import {
  aggregateAsyncQuestions,
  scanPendingAsks
} from '../../../../shared/native-chat/input/native-chat-ask'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { nativeChatPromptDismissals as dismissals } from './native-chat-prompt-dismissals'

export function useNativeChatAsyncQuestions({
  paneKey,
  sourceKey,
  sourceScope,
  viewKey,
  messages,
  settled
}: {
  paneKey: string
  sourceKey: string
  sourceScope: string
  viewKey: string | null
  messages: readonly NativeChatMessage[]
  settled: boolean
}) {
  const scopeKey = `${paneKey}:async:${sourceKey}`
  const owner = useMemo(() => ({ scopeKey, viewKey }), [scopeKey, viewKey])
  const active = useRef<object | null>(null)
  useLayoutEffect(() => {
    active.current = owner
    return () => {
      active.current = null
    }
  }, [owner])
  useLayoutEffect(() => () => dismissals.forgetAsync(scopeKey), [scopeKey])
  const hidden = useSyncExternalStore(dismissals.subscribe, () => dismissals.readAsync(scopeKey))
  const scan = useMemo(() => (settled ? scanPendingAsks(messages) : null), [messages, settled])
  const prompt = useMemo(
    () => aggregateAsyncQuestions(scan?.contributors ?? [], sourceScope, hidden),
    [scan, sourceScope, hidden]
  )
  const dismiss = useCallback(() => {
    if (active.current === owner) {
      dismissals.hideAsync(scopeKey, prompt?.occurrenceIds ?? [])
    }
  }, [owner, scopeKey, prompt])
  return {
    prompt,
    blocking: scan?.blocking ?? null,
    dismiss,
    ownerKey: JSON.stringify([scopeKey, viewKey])
  }
}
