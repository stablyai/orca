import { useEffect, useRef, useState } from 'react'

/** Report target-host agents, or null when unknown; remote detection must not infer absence from client-local probes. */
export function useSkillInstallDetectedAgents(target: {
  environmentId: string
  wslDistro?: string | null
}): { ids: readonly string[] | null; state: 'pending' | 'successful' | 'failed' } {
  const [detected, setDetected] = useState<{
    ids: readonly string[] | null
    state: 'pending' | 'successful' | 'failed'
  }>({ ids: null, state: 'pending' })
  const generationRef = useRef(0)
  const { environmentId, wslDistro } = target

  useEffect(() => {
    const generation = ++generationRef.current
    const isCurrent = (): boolean => generation === generationRef.current
    setDetected({ ids: null, state: 'pending' })
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
          setDetected({ ids: agents, state: agents === null ? 'pending' : 'successful' })
        }
      })
      .catch((cause) => {
        console.warn('[skills] agent detection failed:', cause)
        if (isCurrent()) {
          setDetected({ ids: null, state: 'failed' })
        }
      })
    return () => {
      generationRef.current += 1
    }
  }, [environmentId, wslDistro])

  return detected
}
