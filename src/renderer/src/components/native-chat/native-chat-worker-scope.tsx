import { createContext, useContext, useMemo } from 'react'
import type { NativeChatChildLocation } from './native-chat-child-navigation'
import { useNativeChatSessionChildren } from './use-native-chat-session-children'

type WorkerSource = Extract<NonNullable<NativeChatChildLocation['source']>, { kind: 'worker' }>
type WorkerRoster = ReturnType<typeof useNativeChatSessionChildren>
const WorkerScope = createContext<{ source: WorkerSource; roster: WorkerRoster } | null>(null)

export const useNativeChatWorkerScope = () => useContext(WorkerScope)

export function NativeChatWorkerScope({
  source,
  isVisible,
  children
}: {
  source: WorkerSource
  isVisible: boolean
  children: (roster: WorkerRoster) => React.ReactNode
}): React.JSX.Element {
  const {
    children: workers,
    current,
    loading
  } = useNativeChatSessionChildren({
    target: source.target,
    sessionId: source.parentSessionId,
    dispatchId: source.parentDispatchId,
    enabled: isVisible
  })
  const value = useMemo(
    () => ({
      source,
      roster: { children: workers, current, loading }
    }),
    [source, workers, current, loading]
  )
  return <WorkerScope.Provider value={value}>{children(value.roster)}</WorkerScope.Provider>
}
