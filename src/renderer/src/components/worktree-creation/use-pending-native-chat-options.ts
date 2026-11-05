import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { structuredAgentSessionTargetForHost } from '@/runtime/structured-agent-session-owner'
import { firstFrameOptionState } from '@/components/native-chat/structured-agent-session-option-first-frame'
import { structuredAgentSessionSeedCatalog } from '../../../../shared/agent-session/options/structured-agent-session-seed-catalog'
import {
  applyStructuredAgentSessionModelCatalog,
  type StructuredAgentSessionOptionState
} from '../../../../shared/agent-session/options/structured-agent-session-options'
import {
  structuredAgentSessionOptionView,
  structuredAgentSessionShownSnapshot
} from '../../../../shared/agent-session/options/structured-agent-session-option-view'
import { encodeStructuredAgentSessionOptionValue } from '../../../../shared/agent-session/options/structured-agent-session-option-codec'
import type { AgentSessionModelCatalogResult } from '../../../../shared/agent-session/agent-session-wire'
import type { PendingWorktreeCreation } from '@/lib/pending-worktree-creation'
import type { SessionOptionsSurface } from '../../../../shared/native-chat/input/native-chat-session-options'

export function usePendingNativeChatOptions(
  entry: PendingWorktreeCreation | undefined,
  executionHostId: string | undefined,
  worktreeId: string | undefined
) {
  const agent = entry?.request.agent
  const target = useMemo(
    () => structuredAgentSessionTargetForHost(executionHostId),
    [executionHostId]
  )
  const key = JSON.stringify([entry?.creationId, executionHostId, agent, worktreeId])
  const [catalog, setCatalog] = useState<{
    key: string
    state: StructuredAgentSessionOptionState
  } | null>(null)
  const [demand, setDemand] = useState(0)
  const seed = useMemo(
    () =>
      agent && target
        ? firstFrameOptionState(agent, target, {
            newLaunch: true,
            worktree: worktreeId,
            seedsModel: false
          })
        : null,
    [agent, target, worktreeId]
  )
  useEffect(() => {
    if (!agent || !target) {
      return
    }
    let current = true
    void callStructuredAgentSession<AgentSessionModelCatalogResult>(
      target,
      'agentSession.modelCatalog',
      {
        agent,
        ...(worktreeId ? { worktree: worktreeId } : {}),
        waitForListing: true
      }
    )
      .then((answer) => {
        if (current && seed) {
          setCatalog({
            key,
            state: applyStructuredAgentSessionModelCatalog(
              seed,
              structuredAgentSessionSeedCatalog(agent),
              answer,
              { newLaunch: true }
            )
          })
        }
      })
      .catch(() => {})
    return () => {
      current = false
    }
  }, [agent, demand, key, seed, target, worktreeId])
  const state = catalog?.key === key ? catalog.state : seed
  const picks =
    entry?.request.launchInputs?.chatSessionOptions ?? entry?.request.launchInputs?.sessionOptions
  const snapshot = useMemo(
    () =>
      state
        ? structuredAgentSessionShownSnapshot(
            structuredAgentSessionOptionView(state, undefined, picks ?? {})
          ).map((option) => ({
            ...option,
            settable: option.settable && entry?.chatInputHandedOff !== true
          }))
        : [],
    [entry?.chatInputHandedOff, picks, state]
  )
  const creationId = entry?.creationId
  const surface = useMemo<SessionOptionsSurface>(
    () => ({
      getSnapshot: () => snapshot,
      demandModelCatalog: () => setDemand((count) => count + 1),
      setOption: async (id, value) => {
        const store = useAppStore.getState()
        const current = creationId ? store.pendingWorktreeCreations[creationId] : undefined
        const encoded = encodeStructuredAgentSessionOptionValue(id, value)
        if (
          current &&
          !current.chatInputHandedOff &&
          encoded !== null &&
          snapshot.some((option) => option.id === id && option.settable)
        ) {
          store.updatePendingWorktreeCreation(current.creationId, {
            chatSessionOptions: { [id]: encoded }
          })
        }
        return { snapshot }
      },
      invokeAction: async () => ({ snapshot }),
      subscribe: () => () => {}
    }),
    [creationId, snapshot]
  )
  return { surface, snapshot }
}
