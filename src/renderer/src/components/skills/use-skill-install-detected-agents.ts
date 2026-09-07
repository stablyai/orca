import { useEffect, useRef, useState } from 'react'

/**
 * Agents present on the machine the install targets, or null while that cannot
 * be answered — a paired runtime environment is probed by its own host, not
 * from here, so the picker must not claim its agents are missing.
 */
export function useSkillInstallDetectedAgents(target: {
  environmentId: string
  wslDistro?: string | null
}): readonly string[] | null {
  const [detected, setDetected] = useState<readonly string[] | null>(null)
  const generationRef = useRef(0)
  const { environmentId, wslDistro } = target

  useEffect(() => {
    const generation = ++generationRef.current
    const isCurrent = (): boolean => generation === generationRef.current
    setDetected(null)
    const probe = async (): Promise<readonly string[] | null> => {
      if (environmentId.startsWith('ssh:')) {
        return window.api.preflight.detectRemoteAgents({
          connectionId: environmentId.slice('ssh:'.length)
        })
      }
      if (environmentId !== 'local') {
        return null
      }
      return window.api.preflight.detectAgents(wslDistro ? { wslDistro } : undefined)
    }
    void probe()
      .then((agents) => {
        if (isCurrent()) {
          setDetected(agents)
        }
      })
      .catch((cause) => {
        console.warn('[skills] agent detection failed:', cause)
      })
    return () => {
      generationRef.current += 1
    }
  }, [environmentId, wslDistro])

  return detected
}
