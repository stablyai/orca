import { useLayoutEffect, useMemo, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../../../../../store/index'
import type { NativeChatSessionOptionOwner } from '../../../../../../../shared/native-chat/input/native-chat-session-option-cache'
import {
  sameNativeChatSessionOptionBinding,
  enrichNativeChatSessionOptionBinding
} from '../../../../../../../shared/native-chat/input/native-chat-session-option-binding'
import type { AppState } from '../../../../../store/types'
import type { NativeChatSessionOptionBinding } from '../../../../../../../shared/native-chat/input/native-chat-session-option-binding'
import { parsePaneKey } from '../../../../../../../shared/workspace-layout/stable-pane-id'
import { getConnectionIdFromState } from '@/lib/workspace/ownership/connection-owner-resolution'
import { getTerminalTabOwnerWorktreeId } from '@/store/terminals/terminal-tab-owner-index'

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
}): NativeChatSessionOptionOwner | undefined {
  const { agent, terminalTabId, targetPtyId, paneKey } = args
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
        worktreeId
      ] as const
    })
  )
  const worktreeId = fields[6]
  const targetKey = `${worktreeId}\0${terminalTabId}\0${paneKey ?? ''}`
  const previous = useRef<{ targetKey: string; owner: NativeChatSessionOptionOwner } | null>(null)
  const owner = useMemo(() => {
    if (!targetPtyId) {
      return undefined
    }
    const target = worktreeId ? { agent, terminalTabId, worktreeId, paneKey } : null
    const readCurrentBinding = () =>
      target ? readNativeChatSessionOptionBinding(useAppStore.getState(), target) : null
    const binding = {
      ...readCurrentBinding(),
      agent,
      ptyId: targetPtyId,
      terminalHandle: fields[1]
    }
    return previous.current?.targetKey === targetKey &&
      sameNativeChatSessionOptionBinding(previous.current.owner.binding, binding)
      ? previous.current.owner
      : { binding, readCurrentBinding }
  }, [agent, terminalTabId, targetPtyId, worktreeId, paneKey, fields, targetKey])
  useLayoutEffect(() => {
    if (owner) {
      const current = owner.readCurrentBinding()
      if (current && sameNativeChatSessionOptionBinding(owner.binding, current)) {
        owner.binding = enrichNativeChatSessionOptionBinding(owner.binding, current)
      }
    }
    previous.current = owner ? { targetKey, owner } : null
  }, [owner, fields, targetKey])
  return owner
}
