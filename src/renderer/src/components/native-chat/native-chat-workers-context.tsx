import { createContext, useCallback, useContext, useEffect, useMemo, useRef } from 'react'
import {
  rereadOrchestrationSessionWorkersOnNewRow,
  useOrchestrationSessionsWorkers
} from '@/lib/orchestration-session-workers'
import type { RuntimeClientTarget } from '../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { OrchestrationSessionWorker } from '../../../../shared/orchestration-session-workers'

/** Ask the host again for the chat's workers, as a started worker warrants. */
const NativeChatWorkersRereadContext = createContext<(() => void) | null>(null)

const NO_WORKERS: readonly OrchestrationSessionWorker[] = []

/** The workers this chat started, as its host records them: what a worker row's state badge reads. */
export const NativeChatWorkersContext =
  createContext<readonly OrchestrationSessionWorker[]>(NO_WORKERS)

export function useNativeChatWorkers(): readonly OrchestrationSessionWorker[] {
  return useContext(NativeChatWorkersContext)
}

export function NativeChatWorkersProvider({
  target,
  sessionId,
  visible,
  children
}: {
  target: RuntimeClientTarget
  sessionId: string
  visible: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const reread = useCallback(
    () => rereadOrchestrationSessionWorkersOnNewRow(target, sessionId),
    [target, sessionId]
  )
  const value = useMemo(() => reread, [reread])
  const sessionIds = useMemo(() => [sessionId], [sessionId])
  // The same shared feed the workers tray reads; it polls only while a worker runs.
  const workers = useOrchestrationSessionsWorkers(target, sessionIds, { visible }).get(sessionId)
  return (
    <NativeChatWorkersRereadContext.Provider value={value}>
      <NativeChatWorkersContext.Provider value={workers ?? NO_WORKERS}>
        {children}
      </NativeChatWorkersContext.Provider>
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
