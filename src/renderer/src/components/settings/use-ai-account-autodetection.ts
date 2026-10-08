import { useEffect, useState } from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'

export function useAiAccountAutodetection(
  settings: GlobalSettings,
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
) {
  const environmentId = settings.activeRuntimeEnvironmentId?.trim() || null
  const [remote, setRemote] = useState<{ id: string; enabled?: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!environmentId) {
      return
    }
    let cancelled = false
    void callRuntimeRpc<{ settings: Partial<GlobalSettings> }>(
      { kind: 'environment', environmentId },
      'settings.get',
      {}
    )
      .then((result) => {
        if (!cancelled) {
          setRemote({ id: environmentId, enabled: result.settings.automaticallyDetectAiAccounts })
        }
      })
      .catch(() => {
        if (!cancelled) {
          setRemote({ id: environmentId })
        }
      })
    return () => {
      cancelled = true
    }
  }, [environmentId])
  const enabled = environmentId
    ? remote?.id === environmentId
      ? remote.enabled
      : undefined
    : settings.automaticallyDetectAiAccounts !== false
  const toggle = async (): Promise<void> => {
    if (busy || enabled === undefined) {
      return
    }
    setBusy(true)
    try {
      if (environmentId) {
        const result = await callRuntimeRpc<{ settings: Partial<GlobalSettings> }>(
          { kind: 'environment', environmentId },
          'settings.update',
          { automaticallyDetectAiAccounts: !enabled }
        )
        setRemote({ id: environmentId, enabled: result.settings.automaticallyDetectAiAccounts })
      } else {
        await updateSettings({ automaticallyDetectAiAccounts: !enabled })
      }
    } finally {
      setBusy(false)
    }
  }
  return { enabled, busy, toggle }
}
