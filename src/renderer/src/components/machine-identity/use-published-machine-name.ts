import { useEffect, useState } from 'react'
import { useAppStore } from '@/store'
import { normalizeMachineName } from '../../../../shared/remote-runtime/host-metadata/machine-name'

/** Saved overrides already reached main; query runtime only for the detected name to avoid stale echoes. */
export function usePublishedMachineName(savedOverride: string): string | null {
  const override = normalizeMachineName(savedOverride)
  const [detectedName, setDetectedName] = useState<string | null>(null)

  useEffect(() => {
    if (override) {
      return
    }
    let cancelled = false
    const getRuntimeStatus = window.api.runtime?.getStatus
    if (!getRuntimeStatus) {
      return
    }
    void getRuntimeStatus()
      .then((status) => {
        const detected = normalizeMachineName(status.machineName)
        if (!cancelled && detected) {
          setDetectedName(detected)
        }
      })
      .catch(() => {
        // The settings screen remains usable when the runtime is still starting.
      })
    return () => {
      cancelled = true
    }
  }, [override])

  return override || detectedName
}

/** This computer's name as other computers see it: the Settings rename, else the detected one. */
export function useThisComputerName(): string | null {
  return usePublishedMachineName(useAppStore((s) => s.settings?.machineName ?? ''))
}
