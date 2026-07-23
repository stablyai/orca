import { useCallback, useEffect, useMemo, useState } from 'react'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { useAppStore } from '@/store'
import type { DecisionGate } from '../../../../shared/decision-gate-types'
import { mergePendingDecisionGates } from './decision-gate-attention'

const GATES_CHANGED_EVENT = 'orca:decision-gates-changed'

export function usePendingDecisionGates(): {
  gates: DecisionGate[]
  loading: boolean
  error: string | null
  resolve: (gateId: string, resolution: string) => Promise<void>
} {
  const settings = useAppStore((state) => state.settings)
  const [gates, setGates] = useState<DecisionGate[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const target = useMemo(() => getActiveRuntimeTarget(settings), [settings])

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const result = await callRuntimeRpc<{ gates: DecisionGate[] }>(
        target,
        'orchestration.gateList',
        { status: 'pending' },
        { timeoutMs: 15_000 }
      )
      setGates(mergePendingDecisionGates([], result.gates))
      setError(null)
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : 'Unable to load decisions')
    } finally {
      setLoading(false)
    }
  }, [target])

  useEffect(() => {
    setGates([])
    setLoading(true)
    void refresh()
    const onChanged = (): void => void refresh()
    window.addEventListener(GATES_CHANGED_EVENT, onChanged)
    return () => window.removeEventListener(GATES_CHANGED_EVENT, onChanged)
  }, [refresh])

  const resolve = useCallback(
    async (gateId: string, resolution: string): Promise<void> => {
      await callRuntimeRpc(target, 'orchestration.gateResolve', {
        id: gateId,
        resolution
      })
      setGates((current) => current.filter((gate) => gate.id !== gateId))
    },
    [target]
  )

  return { gates, loading, error, resolve }
}
