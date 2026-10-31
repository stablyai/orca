import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import type { AgentType } from '../../../../shared/native-chat-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { nativeChatChildAgentId } from './native-chat-child-agent-id'

export type NativeChatChildSource =
  | {
      kind: 'journal'
      target: RuntimeClientTarget
      sessionId: string
      agent: AgentType
      workspaceId?: string
    }
  | {
      kind: 'worker'
      target: RuntimeClientTarget
      parentSessionId: string
      parentDispatchId?: string
      dispatchId: string
    }

export type NativeChatChildLocation = {
  agentId: string
  label: string
  source?: NativeChatChildSource
}

export function nativeChatChildLocationKey(child: NativeChatChildLocation): string {
  return JSON.stringify([child.source ?? null, nativeChatChildAgentId(child.agentId)])
}

type NativeChatChildNavigation = {
  open: (child: NativeChatChildLocation) => void
}

export const NativeChatChildNavigationContext = createContext<NativeChatChildNavigation | null>(
  null
)

export function useNativeChatChildNavigation(): NativeChatChildNavigation | null {
  return useContext(NativeChatChildNavigationContext)
}

export function useNativeChatChildNavigator(sessionKey: string) {
  const [location, setLocation] = useState<{
    sessionKey: string
    path: readonly NativeChatChildLocation[]
  }>({ sessionKey, path: [] })
  const path = location.sessionKey === sessionKey ? location.path : []
  const open = useCallback(
    (child: NativeChatChildLocation) => {
      setLocation((current) => {
        const path = current.sessionKey === sessionKey ? current.path : []
        const next = { ...child, agentId: nativeChatChildAgentId(child.agentId) }
        const ancestor = path.findIndex(
          (item) => nativeChatChildLocationKey(item) === nativeChatChildLocationKey(next)
        )
        return {
          sessionKey,
          path: ancestor === -1 ? [...path, next] : path.slice(0, ancestor + 1)
        }
      })
    },
    [sessionKey]
  )
  const back = useCallback(() => {
    setLocation((current) => ({
      sessionKey,
      path: current.sessionKey === sessionKey ? current.path.slice(0, -1) : []
    }))
  }, [sessionKey])
  const navigation = useMemo(() => ({ open }), [open])
  return { path, child: path.at(-1) ?? null, parent: path.at(-2) ?? null, back, navigation }
}
