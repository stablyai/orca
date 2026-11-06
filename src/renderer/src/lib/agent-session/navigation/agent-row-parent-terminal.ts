import { useAppStore } from '@/store/index'
import { hostRouteForAuthority } from '@/runtime/rpc/targets/runtime-client-target'
import { getRuntimeEnvironmentRevision } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import { resolveOwnerOrLocal } from '../../workspace/ownership/worktree-runtime-owner'
import { findActiveRuntimeTerminal } from '../messaging/terminal/active-agent-note-target'
import { parsePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import { authorityKey } from '../../../../../shared/execution-host/host-authority'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'

export type AgentRowIntent = {
  signal: AbortSignal
  latest: () => boolean
  finish: () => void
}

// A newer click owns this pane even while terminal resolution or a local RPC is still pending.
export function startAgentRowIntent(
  intents: Map<string, AbortController>,
  paneKey: string
): AgentRowIntent {
  intents.get(paneKey)?.abort()
  const intent = new AbortController()
  intents.set(paneKey, intent)
  const latest = () => intents.get(paneKey) === intent
  return {
    signal: intent.signal,
    latest,
    finish: () => {
      if (latest()) {
        intents.delete(paneKey)
      }
      intent.abort()
    }
  }
}

type AgentRowParentTerminal =
  | { status: 'unavailable' | 'superseded' }
  | {
      status: 'found'
      handle: string
      target: RuntimeClientTarget
      current: () => boolean
      options: {
        signal: AbortSignal
        expectedEnvironmentPairingRevision: number | undefined
        beforeSend: () => void
      }
    }

export async function findAgentRowParentTerminal(input: {
  intent: AgentRowIntent
  agentType: 'claude' | 'codex'
  paneKey: string
  worktreeId: string
  sessionId: string
}): Promise<AgentRowParentTerminal> {
  const { intent, agentType, paneKey, worktreeId, sessionId } = input
  let current = () => intent.latest() && !intent.signal.aborted
  try {
    const state = useAppStore.getState()
    const parsed = parsePaneKey(paneKey)
    const owner = resolveOwnerOrLocal(state, { workspaceId: worktreeId })
    if (!parsed || owner.kind !== 'resolved') {
      return { status: 'unavailable' }
    }
    const { target } = hostRouteForAuthority(owner.owner)
    const revision =
      target.kind === 'environment'
        ? getRuntimeEnvironmentRevision(target.environmentId)
        : undefined
    const ptyId = state.terminalLayoutsByTabId[parsed.tabId]?.ptyIdsByLeafId?.[parsed.leafId]
    const live = current
    current = () => {
      const now = useAppStore.getState()
      const liveParent = now.agentStatusByPaneKey.get(paneKey)
      const liveOwner = resolveOwnerOrLocal(now, { workspaceId: worktreeId })
      return (
        live() &&
        liveParent?.agentType === agentType &&
        !liveParent.structuredHostOwned &&
        liveParent.paneKey === paneKey &&
        liveParent.providerSession?.id === sessionId &&
        liveOwner.kind === 'resolved' &&
        authorityKey(liveOwner.owner) === authorityKey(owner.owner) &&
        (target.kind === 'local' ||
          (revision !== undefined &&
            getRuntimeEnvironmentRevision(target.environmentId) === revision)) &&
        now.terminalLayoutsByTabId[parsed.tabId]?.ptyIdsByLeafId?.[parsed.leafId] === ptyId
      )
    }
    const options = {
      signal: intent.signal,
      expectedEnvironmentPairingRevision: revision,
      beforeSend: () => {
        if (!current()) {
          throw new Error('Agent row view superseded')
        }
      }
    }
    if (!current()) {
      return { status: 'unavailable' }
    }
    const terminal = await findActiveRuntimeTerminal(target, worktreeId, parsed, 3000, options)
    if (!current()) {
      return { status: 'superseded' }
    }
    if (!terminal) {
      return { status: 'unavailable' }
    }
    return { status: 'found', handle: terminal.handle, target, current, options }
  } catch {
    return { status: current() ? 'unavailable' : 'superseded' }
  }
}
