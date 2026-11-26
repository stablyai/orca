import { useAppStateValue } from '@/store/retained-views/app-state-view'
import { useEffect, useRef } from 'react'
import { useAppStore } from '@/store/index'
import type { AgentDetectionTarget } from '@/lib/agent-session/launch/inventory/useDetectedAgents'
import { isIncompleteAgentInventory } from '@/store/slices/agent-inventory/managed-agent-launch-commands'
import { getRuntimeAgentInventoryKey } from '@/store/slices/agent-inventory/runtime-agent-inventory-key'

export function useAgentPickerInventoryRetry(
  open: boolean,
  detectionTarget: AgentDetectionTarget | undefined,
  wakeWslDistro: boolean
): void {
  const worktreeId =
    open && detectionTarget?.kind === 'local' ? (detectionTarget.worktreeId ?? null) : undefined
  const runtime = open && detectionTarget?.kind === 'runtime' ? detectionTarget : undefined
  const environmentId = runtime?.environmentId
  const runtimeWorktreeId = runtime?.worktreeId
  const runtimeKey = environmentId && getRuntimeAgentInventoryKey(environmentId, runtimeWorktreeId)
  const key = runtimeKey
    ? `runtime:${runtimeKey}`
    : worktreeId === undefined
      ? null
      : `local:${worktreeId ?? ''}`
  const retriedKey = useRef<string | null>(null)
  const shouldRetry = useAppStateValue((state) => {
    if (runtimeKey) {
      return (
        state.runtimeAgentInventoryOutcome(runtimeKey) === 'failed' ||
        isIncompleteAgentInventory(state.runtimeDetectedAgentIds[runtimeKey])
      )
    }
    if (worktreeId === undefined) {
      return false
    }
    const inventory = state.readLocalAgentInventory(worktreeId)
    return (
      isIncompleteAgentInventory(inventory.ids) ||
      (inventory.state === 'failed' &&
        (wakeWslDistro || !state.isLocalAgentInventoryRefused(worktreeId)))
    )
  })
  useEffect(() => {
    if (key === null) {
      retriedKey.current = null
      return
    }
    // Retry once per opening, even if this retry also reports an incomplete inventory.
    if (!shouldRetry || retriedKey.current === key) {
      return
    }
    retriedKey.current = key
    const state = useAppStore.getState()
    if (environmentId) {
      void state.ensureRuntimeDetectedAgents(environmentId, runtimeWorktreeId)
    } else if (wakeWslDistro) {
      void state.ensureDetectedAgentsForPicker(worktreeId)
    } else {
      void state.ensureDetectedAgents(worktreeId)
    }
  }, [environmentId, key, runtimeWorktreeId, shouldRetry, wakeWslDistro, worktreeId])
}
