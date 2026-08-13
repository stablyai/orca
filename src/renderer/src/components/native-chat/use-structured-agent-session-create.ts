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
  writerSupported: boolean
  creating: boolean
  create: (effectAuthority?: 'local_structured_write') => Promise<boolean>
} {
  const environmentId = useAppStore((state) =>
    getRuntimeEnvironmentIdForWorktree(state, worktreeId)
  )
  const target = useMemo(
    () => getActiveRuntimeTarget({ activeRuntimeEnvironmentId: environmentId }),
    [environmentId]
  )
  const [supported, setSupported] = useState(false)
  const [writerSupported, setWriterSupported] = useState(false)
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    let stale = false
    setSupported(false)
    setWriterSupported(false)
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
      const [support, writerSupport] = await Promise.all([
        callStructuredAgentSession<{ supported?: boolean }>(target, 'agentSession.createSupport', {
          worktree: toRuntimeWorktreeSelector(worktreeId),
          agent: 'codex'
        }),
        target.kind === 'local'
          ? callStructuredAgentSession<{ supported?: boolean }>(
              target,
              'agentSession.createSupport',
              {
                worktree: toRuntimeWorktreeSelector(worktreeId),
                agent: 'codex',
                effectAuthority: 'local_structured_write'
              }
            ).catch(() => ({ supported: false }))
          : Promise.resolve({ supported: false })
      ])
      if (!stale) {
        setSupported(
          showStructuredAgentSessionChoice({
            hostCapability,
            workspaceSupport: support.supported === true,
            agent: 'codex'
          })
        )
        setWriterSupported(
          showStructuredAgentSessionChoice({
            hostCapability,
            workspaceSupport: writerSupport.supported === true,
            agent: 'codex'
          })
        )
      }
    })().catch(() => !stale && setSupported(false))
    return () => {
      stale = true
    }
  }, [target, worktreeId])

  const create = useCallback(
    async (effectAuthority?: 'local_structured_write'): Promise<boolean> => {
      if ((!effectAuthority && !supported) || (effectAuthority && !writerSupported) || creating) {
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
            payloadFingerprint: structuredAgentSessionCreateFingerprint({
              sessionId,
              worktree,
              effectAuthority
            })
          },
          worktree,
          agent: 'codex',
          ...(effectAuthority ? { effectAuthority } : {})
        })
        if (!result.ok) {
          throw new Error(result.refusal.message)
        }
        return true
      } finally {
        setCreating(false)
      }
    },
    [creating, supported, target, worktreeId, writerSupported]
  )

  return { supported, writerSupported, creating, create }
}
