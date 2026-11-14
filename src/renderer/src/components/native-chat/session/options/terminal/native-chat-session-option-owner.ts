import { useLayoutEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../../../../../store/index'
import { readNativeChatSessionOptionSeedBinding } from '../../../../../../../shared/native-chat/input/native-chat-session-option-cache'
import {
  createNativeChatSessionOptionOwner,
  type NativeChatSessionOptionOwner
} from '../../../../../../../shared/native-chat/input/native-chat-session-option-owner'
import {
  sameNativeChatSessionOptionBinding,
  enrichNativeChatSessionOptionBinding,
  nativeChatSessionOptionBindingObservationsEqual
} from '../../../../../../../shared/native-chat/input/native-chat-session-option-binding'
import type { AppState } from '../../../../../store/types'
import type { NativeChatSessionOptionBinding } from '../../../../../../../shared/native-chat/input/native-chat-session-option-binding'
import { parsePaneKey } from '../../../../../../../shared/workspace-layout/stable-pane-id'
import { getConnectionIdFromState } from '@/lib/workspace/ownership/connection-owner-resolution'
import { getTerminalTabOwnerWorktreeId } from '@/store/terminals/terminal-tab-owner-index'

const subscribeEmpty = (): (() => void) => () => {}
const getEmptySnapshot = (): undefined => undefined

export function readNativeChatSessionOptionBinding(
  state: AppState,
  target: { agent: string; terminalTabId: string; worktreeId: string; paneKey?: string }
): NativeChatSessionOptionBinding | null {
  const tab = state.tabsByWorktree[target.worktreeId]?.find(
    (row) => row.id === target.terminalTabId
  )
  if (!tab) {
    return null
  }
  const leaf = target.paneKey ? parsePaneKey(target.paneKey) : null
  const ptyId = leaf
    ? state.terminalLayoutsByTabId[target.terminalTabId]?.ptyIdsByLeafId?.[leaf.leafId]
    : tab.ptyId
  if (!ptyId) {
    return null
  }
  const status = target.paneKey ? state.agentStatusByPaneKey[target.paneKey] : undefined
  return {
    agent: status?.agentType ?? target.agent,
    ptyId,
    connectionId: getConnectionIdFromState(state, target.worktreeId),
    worktreeId: target.worktreeId,
    terminalHandle: status?.terminalHandle,
    providerSession: status?.providerSession
  }
}

export function useNativeChatSessionOptionOwner(args: {
  agent: string
  terminalTabId: string
  targetPtyId: string | null
  paneKey?: string
}): { owner: NativeChatSessionOptionOwner | undefined; targetAvailable: boolean } {
  const { agent, terminalTabId, targetPtyId, paneKey } = args
  const leaf = paneKey ? parsePaneKey(paneKey) : null
  const fields = useAppStore(
    useShallow((state) => {
      const worktreeId = getTerminalTabOwnerWorktreeId(state.tabsByWorktree, terminalTabId)
      const status = paneKey ? state.agentStatusByPaneKey[paneKey] : undefined
      return [
        status?.agentType,
        status?.terminalHandle,
        getConnectionIdFromState(state, worktreeId ?? null),
        status?.providerSession?.key,
        status?.providerSession?.id,
        status?.providerSession?.transcriptPath,
        worktreeId,
        leaf
          ? state.terminalLayoutsByTabId[terminalTabId]?.ptyIdsByLeafId?.[leaf.leafId]
          : targetPtyId
      ] as const
    })
  )
  const worktreeId = fields[6]
  const targetKey = `${worktreeId}\0${terminalTabId}\0${paneKey ?? ''}`
  const candidate = useMemo<NativeChatSessionOptionBinding>(
    () => ({
      agent,
      ptyId: targetPtyId,
      terminalHandle: fields[1],
      connectionId: fields[2],
      worktreeId: worktreeId ?? undefined,
      providerSession:
        fields[3] && fields[4] !== undefined
          ? { key: fields[3], id: fields[4], transcriptPath: fields[5] }
          : undefined
    }),
    [agent, targetPtyId, worktreeId, fields]
  )
  const [held, setHeld] = useState<{
    targetKey: string
    observation: NativeChatSessionOptionBinding
    owner: NativeChatSessionOptionOwner
  } | null>(null)
  const domainObservation = useSyncExternalStore(
    held?.owner.subscribe ?? subscribeEmpty,
    held?.owner.getSnapshot ?? getEmptySnapshot,
    held?.owner.getSnapshot ?? getEmptySnapshot
  )
  let selected = held
  if (!targetPtyId) {
    selected = null
  } else {
    const previous =
      held?.targetKey === targetKey
        ? enrichNativeChatSessionOptionBinding(
            held.observation,
            domainObservation ?? held.observation
          )
        : null
    if (!held || !previous || !sameNativeChatSessionOptionBinding(previous, candidate)) {
      const observation = readNativeChatSessionOptionSeedBinding(targetPtyId, candidate)
      const target = worktreeId ? { agent, terminalTabId, worktreeId, paneKey } : null
      selected = {
        targetKey,
        observation,
        owner: createNativeChatSessionOptionOwner(observation, () =>
          target ? readNativeChatSessionOptionBinding(useAppStore.getState(), target) : null
        )
      }
    } else {
      const observation = enrichNativeChatSessionOptionBinding(previous, candidate)
      if (!nativeChatSessionOptionBindingObservationsEqual(held.observation, observation)) {
        selected = { ...held, observation }
      }
    }
  }
  if (selected !== held) {
    setHeld(selected)
  }
  const owner = selected?.owner
  const observation = selected?.observation
  useLayoutEffect(() => {
    if (observation) {
      owner?.captureBinding(observation)
    }
    owner?.currentBinding()
  }, [owner, observation, fields])
  return {
    owner,
    targetAvailable: Boolean(worktreeId && targetPtyId && fields[7] === targetPtyId)
  }
}
