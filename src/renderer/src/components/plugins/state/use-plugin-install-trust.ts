import { useCallback, useEffect, useRef } from 'react'
import type { PluginInstallTrustPrompt } from '../presentation/plugin-install-trust'
import {
  confirmPluginInstallTrust,
  settlePluginInstallTrust,
  usePluginInstallTrustStore
} from '@/store/plugins/installation/plugin-install-trust-request'

export function usePluginInstallTrust(active = true) {
  const activeRef = useRef(active)
  const waiting = useRef<PluginInstallTrustPrompt | null>(null)
  useEffect(() => {
    activeRef.current = active
    return () => {
      activeRef.current = false
      if (
        waiting.current &&
        usePluginInstallTrustStore.getState().pending?.prompt === waiting.current
      ) {
        settlePluginInstallTrust(false)
      }
    }
  }, [active])
  return useCallback(async (prompt: PluginInstallTrustPrompt): Promise<boolean> => {
    if (!activeRef.current) {
      return false
    }
    waiting.current = prompt
    const confirmed = await confirmPluginInstallTrust(prompt)
    if (waiting.current === prompt) {
      waiting.current = null
    }
    return confirmed && activeRef.current
  }, [])
}
