import { useEffect, useState } from 'react'
import { normalizeMachineName } from '../../../../shared/machine-name'

/**
 * The name this computer publishes to paired devices: the saved override when there is one, else
 * the detected computer name.
 *
 * Why the override is not read back from the runtime: the store only holds a saved value after the
 * main process has written it, so it already is what devices see. The runtime is asked only for
 * the detected name, which nothing in the renderer can compute.
 */
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
