import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import { callStructuredAgentSession } from '@/runtime/native-chat/requests/structured-agent-session-call'
import { structuredAgentSessionTargetForHost } from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'
import { firstFrameOptionState } from '@/components/native-chat/session/options/structured/structured-agent-session-option-first-frame'
import { structuredAgentSessionSeedCatalog } from '../../../../shared/agent-session/options/model-catalog/structured-agent-session-seed-catalog'
import {
  applyStructuredAgentSessionModelCatalog,
  settleStructuredAgentSessionBuiltinCatalog,
  type StructuredAgentSessionOptionState
} from '../../../../shared/agent-session/options/structured-agent-session-options'
import { structuredLaunchSeedOptions } from '../../../../shared/native-chat/input/session-options/native-chat-session-option-defaults'
import { joinHostModelListingWait } from '../../../../shared/host-model-listing-waits'
import { recordHostModelCatalogSnapshot } from '@/runtime/native-chat/model-catalogs/host-model-catalog-snapshots'
import { structuredAgentSessionHostKey } from '@/runtime/native-chat/host-capabilities/structured-agent-session-host-capability'
import { toRuntimeWorktreeSelector } from '@/runtime/rpc/targets/runtime-worktree-selector'
import {
  structuredAgentSessionOptionView,
  structuredAgentSessionShownSnapshot
} from '../../../../shared/agent-session/options/view/structured-agent-session-option-view'
import { encodeStructuredAgentSessionOptionValue } from '../../../../shared/agent-session/options/selection/structured-agent-session-option-codec'
import type { AgentSessionModelCatalogResult } from '../../../../shared/agent-session/agent-session-wire'
import type { PendingWorktreeCreation } from '@/lib/workspace/creation/pending-worktree-creation'
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
  // A local chat seeds the saved selection and permission default, as its launch will; a paired host names its own.
  const settings = useAppStore((s) => s.settings)
  const launchSeed = useMemo(
    () =>
      target?.kind === 'local' && agent ? structuredLaunchSeedOptions(settings, agent) : undefined,
    [agent, settings, target?.kind]
  )
  const seedsModel = launchSeed?.model !== undefined
  const seed = useMemo(
    () =>
      agent && target
        ? firstFrameOptionState(agent, target, {
            newLaunch: true,
            ...(worktreeId ? { worktree: toRuntimeWorktreeSelector(worktreeId) } : {}),
            seedsModel
          })
        : null,
    [agent, seedsModel, target, worktreeId]
  )
  useEffect(() => {
    if (!agent || !target || !seed) {
      return
    }
    // Re-reads while the host's listing runs; a failed read falls back to the built-in list instead of a dead pill.
    return joinHostModelListingWait(
      `${structuredAgentSessionHostKey(target)}\u0000${agent}\u0000${key}`,
      () =>
        callStructuredAgentSession<AgentSessionModelCatalogResult>(
          target,
          'agentSession.modelCatalog',
          { agent, ...(worktreeId ? { worktree: worktreeId } : {}), waitForListing: true }
        ),
      (answer) => {
        if (answer && worktreeId) {
          // The worktree's chat opens from this answer instead of waiting for its own read.
          recordHostModelCatalogSnapshot(
            target,
            agent,
            toRuntimeWorktreeSelector(worktreeId),
            answer
          )
        }
        setCatalog((previous) => ({
          key,
          state: answer
            ? applyStructuredAgentSessionModelCatalog(
                seed,
                structuredAgentSessionSeedCatalog(agent),
                answer,
                { newLaunch: true }
              )
            : // A failed re-read keeps a list an earlier read already brought.
              settleStructuredAgentSessionBuiltinCatalog(
                previous?.key === key ? previous.state : seed,
                false
              )
        }))
      }
    )
  }, [agent, demand, key, seed, target, worktreeId])
  const state = catalog?.key === key ? catalog.state : seed
  const picks =
    entry?.request.launchInputs?.chatSessionOptions ?? entry?.request.launchInputs?.sessionOptions
  const snapshot = useMemo(
    () =>
      state
        ? structuredAgentSessionShownSnapshot(
            structuredAgentSessionOptionView(state, launchSeed, picks ?? {})
          ).map((option) => ({
            ...option,
            settable: option.settable && entry?.chatInputHandedOff !== true
          }))
        : [],
    [entry?.chatInputHandedOff, launchSeed, picks, state]
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
