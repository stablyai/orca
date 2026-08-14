import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  AgentSessionAttachResult,
  AgentSessionMutationResult
} from '../../../../shared/agent-session-wire'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import {
  createStructuredAgentSessionOperationId,
  showStructuredAgentSessionChoice,
  structuredAgentSessionCreateFingerprint
} from '../../../../shared/structured-agent-session-mutation'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { useAppStore } from '@/store'
import {
  getActiveRuntimeTarget,
  runtimeEnvironmentSupportsCapability
} from '@/runtime/runtime-rpc-client'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import { recordWebSessionFocusIntent } from '@/runtime/web-session-focus-intent'

const LOCAL_OWNER = 'local-structured-session'

export function useStructuredAgentSessionCreate(worktreeId: string): {
  supported: boolean
  creating: boolean
  create: () => Promise<boolean>
} {
  const environmentId = useAppStore((state) =>
    getRuntimeEnvironmentIdForWorktree(state, worktreeId)
  )
  const target = useMemo(
    () => getActiveRuntimeTarget({ activeRuntimeEnvironmentId: environmentId }),
    [environmentId]
  )
  const [supported, setSupported] = useState(false)
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    let stale = false
    setSupported(false)
    void (async () => {
      const hostCapability =
        target.kind === 'local'
          ? ((await window.api.runtime.getStatus()).capabilities?.includes(
              STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
            ) ?? false)
          : await runtimeEnvironmentSupportsCapability(
              target.environmentId,
              STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
            )
      if (!hostCapability) {
        return
      }
      const support = await callStructuredAgentSession<{ supported?: boolean }>(
        target,
        'agentSession.createSupport',
        { worktree: toRuntimeWorktreeSelector(worktreeId), agent: 'codex' }
      )
      if (!stale) {
        setSupported(
          showStructuredAgentSessionChoice({
            hostCapability,
            workspaceSupport: support.supported === true,
            agent: 'codex'
          })
        )
      }
    })().catch(() => !stale && setSupported(false))
    return () => {
      stale = true
    }
  }, [target, worktreeId])

  const create = useCallback(async (): Promise<boolean> => {
    if (!supported || creating) {
      return false
    }
    setCreating(true)
    const sessionId = `desktop_${Date.now().toString(36)}${crypto.randomUUID().slice(0, 8)}`
    const worktree = toRuntimeWorktreeSelector(worktreeId)
    try {
      recordWebSessionFocusIntent(
        { environmentId: target.kind === 'environment' ? target.environmentId : LOCAL_OWNER },
        worktreeId,
        `agent-session:${sessionId}`
      )
      const result = await callStructuredAgentSession<
        AgentSessionMutationResult<AgentSessionAttachResult>
      >(target, 'agentSession.create', {
        envelope: {
          sessionId,
          clientOperationId: createStructuredAgentSessionOperationId(() => crypto.randomUUID()),
          expectedRuntimeFence: null,
          payloadFingerprint: structuredAgentSessionCreateFingerprint({ sessionId, worktree })
        },
        worktree,
        agent: 'codex'
      })
      if (!result.ok) {
        throw new Error(result.refusal.message)
      }
      return true
    } finally {
      setCreating(false)
    }
  }, [creating, supported, target, worktreeId])

  return { supported, creating, create }
}
