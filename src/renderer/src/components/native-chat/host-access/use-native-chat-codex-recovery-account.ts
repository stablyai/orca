import { useEffect, useReducer, useState } from 'react'

export function useNativeChatCodexRecoveryAccount(
  sessionId: string | undefined,
  needsSignIn: boolean | undefined,
  failureKey: string,
  selection: string | null
) {
  const [version, retry] = useReducer((count: number) => count + 1, 0)
  const [lookup, setLookup] = useState<{
    sessionId: string
    failureKey: string
    selection: string | null
    version: number
    id: string | null | undefined
  } | null>(null)
  if (!needsSignIn && lookup?.id === null) {
    setLookup(null)
  }
  useEffect(() => {
    if (!sessionId || !needsSignIn) {
      return
    }
    let current = true
    void window.api.codexAccounts
      .chatSignInAccount({ sessionId })
      .catch(() => undefined)
      .then((id) => {
        if (current) {
          setLookup({ sessionId, failureKey, selection, version, id })
        }
      })
    return () => {
      current = false
    }
  }, [sessionId, failureKey, selection, needsSignIn, version])
  const forSession = lookup?.sessionId === sessionId ? lookup : null
  const matched =
    forSession?.failureKey === failureKey &&
    forSession.selection === selection &&
    forSession.version === version
  return {
    accountId: matched ? forSession.id : null,
    lastAccountId: forSession?.id,
    blocksTerminal: Boolean(sessionId && needsSignIn && (!matched || forSession.id === undefined)),
    failed: matched && forSession.id === undefined,
    retry
  }
}
