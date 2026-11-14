import { useLayoutEffect, useEffectEvent, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { hasRuntimeRpcErrorCode } from '../../../../../shared/remote-runtime/rpc/runtime-rpc-error-code'
import type { WorkspaceCleanupPolicyRead } from '../../../../../shared/workspace-cleanup/workspace-cleanup-policy-change'

export function useWorkspaceCleanupPolicyOwner(owner: RuntimeClientTarget, repoId: string | null) {
  const scopeKey = `${owner.kind === 'environment' ? owner.environmentId : 'local'}:${repoId ?? 'global'}`
  const generation = useRef(0)
  const [read, setRead] = useState<WorkspaceCleanupPolicyRead | null>(null)
  const [capability, setCapability] = useState<'loading' | 'ready' | 'old' | 'error'>('loading')
  const readLatest = () =>
    callRuntimeRpc<WorkspaceCleanupPolicyRead>(owner, 'workspaceCleanup.policyState', { repoId })
  const adopt = (value: WorkspaceCleanupPolicyRead) => {
    setRead(value)
    if (owner.kind !== 'local') {
      return
    }
    const projects = new Map(value.state.projects.map((row) => [`${row.hostId}:${row.id}`, row]))
    useAppStore.setState((state) => ({
      settings: state.settings
        ? { ...state.settings, workspaceCleanupPolicy: value.state.rules }
        : state.settings,
      repos: state.repos.map((repo) => {
        const entry = projects.get(`${repo.executionHostId ?? 'local'}:${repo.id}`)
        return entry ? { ...repo, workspaceCleanupPolicy: entry.policy ?? undefined } : repo
      })
    }))
  }
  const reload = async () => {
    const token = generation.current
    try {
      const value = await readLatest()
      if (token !== generation.current) {
        return
      }
      adopt(value)
      setCapability(value.protocol === 1 ? 'ready' : 'old')
    } catch (failure) {
      if (token === generation.current) {
        setCapability(hasRuntimeRpcErrorCode(failure, 'method_not_found') ? 'old' : 'error')
      }
    }
  }
  const reloadEffect = useEffectEvent(() => reload())
  useLayoutEffect(() => {
    const token = generation.current + 1
    generation.current = token
    setRead(null)
    setCapability('loading')
    void reloadEffect()
    return () => {
      generation.current = token + 1
    }
  }, [scopeKey])
  return { read, capability, adopt, readLatest, generation, scopeKey, reload }
}
