import { useCallback, useEffect, useState } from 'react'
import {
  agentChatPermissionModes,
  newChatPermissionModeForSettings
} from '../../../shared/agent-chat-permission-mode'
import {
  chatPermissionHostVerdict,
  hostSettingsApplyChatPermissionModes,
  legacyHostChatPermissionMode,
  type ChatPermissionHostVerdict
} from '../../../shared/agent-chat-permission-host-support'
import { AGENT_SESSION_PERMISSION_MODES_RUNTIME_CAPABILITY } from '../../../shared/agent-session-permission-modes-capability'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { useAppStore } from '@/store'
import { callRuntimeRpc, runtimeEnvironmentSupportsCapability } from './runtime-rpc-client'
import { subscribeRuntimeHostContactRegained } from './runtime-host-contact-regained'

/** `unverified`: the host could not say what it runs, so nothing may start there yet. */
export type StructuredChatHostPermissionVerdict = ChatPermissionHostVerdict | { kind: 'unverified' }

const HOST_PERMISSION_READ_TIMEOUT_MS = 15_000
/** How often a held chat asks again: the host's Agent Permissions can change with no reconnect. */
const HELD_RECHECK_MS = 30_000

/** The mode this client asks new chats to start in; on a paired host that predates per-chat modes
 *  it is the only stated intent, since that host keeps none. */
function requestedChatPermissionMode(agent: string): unknown {
  return newChatPermissionModeForSettings(agent, useAppStore.getState().settings)
}

/**
 * Whether a chat on `target` may start or take a turn without running with more access than this
 * client asks for. A paired host that does not apply per-chat modes runs its Agent Permissions.
 */
export async function readStructuredChatHostPermissionVerdict(
  target: RuntimeClientTarget,
  agent: string,
  requested: unknown = requestedChatPermissionMode(agent)
): Promise<StructuredChatHostPermissionVerdict> {
  if (target.kind === 'local' || !agentChatPermissionModes(agent)) {
    return { kind: 'allowed' }
  }
  const advertised = await runtimeEnvironmentSupportsCapability(
    target.environmentId,
    AGENT_SESSION_PERMISSION_MODES_RUNTIME_CAPABILITY,
    HOST_PERMISSION_READ_TIMEOUT_MS
  ).catch(() => false)
  if (advertised) {
    return { kind: 'allowed' }
  }
  let settings: unknown
  try {
    const result = await callRuntimeRpc<{ settings?: unknown }>(target, 'settings.get', undefined, {
      timeoutMs: HOST_PERMISSION_READ_TIMEOUT_MS
    })
    settings = result.settings
  } catch {
    return { kind: 'unverified' }
  }
  return chatPermissionHostVerdict({
    agent,
    hostAppliesModes: hostSettingsApplyChatPermissionModes(settings),
    legacyMode: legacyHostChatPermissionMode(agent, settings),
    requested
  })
}

/** `checking` until the host has answered; asked again on each regained contact, change of the
 *  requested mode and, while held, every 30s, so an updated host is let through without a reload. */
export function useStructuredChatHostPermissionVerdict(
  target: RuntimeClientTarget,
  agent: string
): (StructuredChatHostPermissionVerdict | { kind: 'checking' }) & { checkAgain: () => void } {
  const gated = target.kind === 'environment' && agentChatPermissionModes(agent) !== null
  const environmentId = target.kind === 'environment' ? target.environmentId : null
  const requested = useAppStore((state) => newChatPermissionModeForSettings(agent, state.settings))
  const [contact, setContact] = useState(0)
  // Contact is part of the key: a host back from a restart may be an older build, so a verdict from
  // before it never stands in for the fresh one.
  const key = `${environmentId ?? 'local'}\0${agent}\0${String(requested)}\0${contact}`
  const [answer, setAnswer] = useState<{
    key: string
    verdict: StructuredChatHostPermissionVerdict
  } | null>(null)
  // Not in the key: a held chat stays held while it asks again.
  const [recheck, setRecheck] = useState(0)
  const checkAgain = useCallback(() => setRecheck((n) => n + 1), [])
  const held = answer?.key === key && answer.verdict.kind !== 'allowed'
  useEffect(() => {
    if (!held) {
      return
    }
    const timer = setTimeout(() => setRecheck((n) => n + 1), HELD_RECHECK_MS)
    return () => clearTimeout(timer)
  }, [answer, held])
  useEffect(() => {
    if (!gated || environmentId === null) {
      return
    }
    return subscribeRuntimeHostContactRegained(environmentId, () => setContact((n) => n + 1))
  }, [environmentId, gated])
  useEffect(() => {
    if (!gated || environmentId === null) {
      return
    }
    let cancelled = false
    void readStructuredChatHostPermissionVerdict(
      { kind: 'environment', environmentId },
      agent,
      requested
    ).then((verdict) => {
      if (!cancelled) {
        setAnswer({ key, verdict })
      }
    })
    return () => {
      cancelled = true
    }
  }, [agent, contact, environmentId, gated, key, recheck, requested])
  if (!gated) {
    return { kind: 'allowed', checkAgain }
  }
  return { ...(answer?.key === key ? answer.verdict : { kind: 'checking' as const }), checkAgain }
}
