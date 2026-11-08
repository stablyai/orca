import { useEffect, useRef, useState } from 'react'

/** Report target-host agents, or null when unknown; remote detection must not infer absence from client-local probes. */
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
