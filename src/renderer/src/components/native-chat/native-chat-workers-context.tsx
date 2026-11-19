import { createContext, useCallback, useContext, useEffect, useMemo, useRef } from 'react'
import { rereadOrchestrationSessionWorkersOnNewRow } from '@/lib/orchestration-session-workers'
import type { RuntimeClientTarget } from '../../../../shared/remote-runtime/host-catalog/runtime-client-target'

/** Ask the host again for the chat's workers, as a started worker warrants. */
const NativeChatWorkersRereadContext = createContext<(() => void) | null>(null)

export function NativeChatWorkersProvider({
  target,
  sessionId,
  children
}: {
  target: RuntimeClientTarget
  sessionId: string
  children: React.ReactNode
}): React.JSX.Element {
  const reread = useCallback(
    () => rereadOrchestrationSessionWorkersOnNewRow(target, sessionId),
    [target, sessionId]
  )
  const value = useMemo(() => reread, [reread])
  return (
    <NativeChatWorkersRereadContext.Provider value={value}>
      {children}
    </NativeChatWorkersRereadContext.Provider>
  )
}

/** The feed polls only while a worker runs; a new transcript row may be the command that started one. */
export function useRereadWorkersOnNewRows(rowCount: number): void {
  const reread = useContext(NativeChatWorkersRereadContext)
  const seen = useRef(rowCount)
  useEffect(() => {
    if (rowCount !== seen.current) {
      seen.current = rowCount
      reread?.()
    }
  }, [reread, rowCount])
}
