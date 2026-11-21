import { cleanupPolicyOwnerKey } from './workspace-cleanup-write-journal'
import { readCleanupPolicy } from './workspace-cleanup-policy-client'
import { cleanupWritePhase, waitForCleanupWrite } from './workspace-cleanup-pending-write'
import { useEffect, useLayoutEffect, useEffectEvent, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { subscribeHostSettingsChanged } from '@/runtime/rpc/subscriptions/host-settings-changed'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { hasRuntimeRpcErrorCode } from '../../../../../shared/remote-runtime/rpc/runtime-rpc-error-code'
import type { WorkspaceCleanupPolicyRead } from '../../../../../shared/workspace-cleanup/workspace-cleanup-policy-change'

export function useWorkspaceCleanupPolicyOwner(owner: RuntimeClientTarget, repoId: string | null) {
  const scopeKey = `${cleanupPolicyOwnerKey(owner)}:${repoId ?? 'global'}`
  const generation = useRef(0)
  const [recovering, setRecovering] = useState(false)
  const [read, setRead] = useState<WorkspaceCleanupPolicyRead | null>(null)
  const [capability, setCapability] = useState<'loading' | 'ready' | 'old' | 'error'>('loading')
  // Reads can finish out of order. Each is numbered when it is sent, after any pending write
  // settles, so a read queued behind a save counts as newer than that save's readback.
  const reads = useRef({ sent: 0, adopted: 0 })
  const readInOrder = async () => {
    const token = generation.current
    // A save can start while this resumes; wait it out too so the number is taken with no write pending.
    do {
      await waitForCleanupWrite(owner)
    } while (cleanupWritePhase(owner) !== 'idle')
    const order = ++reads.current.sent
    const value = await readCleanupPolicy(
      owner,
      repoId,
      (next) => {
        if (token === generation.current) {
          setRecovering(next)
        }
      },
      () => token === generation.current
    )
    return { order, value }
  }
  const readLatest = async () => (await readInOrder()).value

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
  const load = async (keepOnFailure: boolean) => {
    const token = generation.current
    // A read that fails before it is sent can't be ordered; let it report only if nothing newer landed.
    const floor = reads.current.adopted
    try {
      const { order, value } = await readInOrder()
      if (token !== generation.current || order <= reads.current.adopted) {
        return
      }
      reads.current.adopted = order
      adopt(value)
      setCapability(value.protocol === 3 ? 'ready' : 'old')
    } catch (failure) {
      if (!keepOnFailure && token === generation.current && reads.current.adopted === floor) {
        setCapability(hasRuntimeRpcErrorCode(failure, 'method_not_found') ? 'old' : 'error')
      }
    }
  }
  const reload = () => load(false)
  // Call before a save starts. Its readback replaces reads sent before the save, never one
  // sent after it settled.
  const startSave = () => {
    const epoch = reads.current.sent
    return (value: WorkspaceCleanupPolicyRead) => {
      if (reads.current.adopted > epoch) {
        return
      }
      reads.current.adopted = epoch
      adopt(value)
    }
  }
  const reloadEffect = useEffectEvent(() => reload())
  // Another client may change this host's rules while the pane is open; writes still re-read first.
  // A failed refresh keeps the last read; the next write or retry reads the host again.
  const refreshEffect = useEffectEvent(() => load(true))
  const environmentId = owner.kind === 'environment' ? owner.environmentId : null
  useEffect(() => {
    if (!environmentId) {
      return
    }
    return subscribeHostSettingsChanged((changedId, keys) => {
      if (changedId === environmentId && keys.includes('workspaceCleanupPolicy')) {
        void refreshEffect()
      }
    })
  }, [environmentId])
  useLayoutEffect(() => {
    const token = generation.current + 1
    generation.current = token
    setRead(null)
    setRecovering(false)
    setCapability('loading')
    void reloadEffect()
    return () => {
      generation.current = token + 1
    }
  }, [scopeKey])
  return {
    read,
    recovering,
    capability,
    startSave,
    readLatest,
    generation,
    scopeKey,
    reload
  }
}
