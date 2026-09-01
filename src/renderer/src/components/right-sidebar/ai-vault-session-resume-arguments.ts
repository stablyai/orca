import { useEffect, useState } from 'react'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { sessionResumeArgsLabel } from './ai-vault-session-display'
import { buildAiVaultResumeEntry } from './ai-vault-resume-entry'

export function useSessionResumeArguments(session: AiVaultSession): string | null | undefined {
  const [resumeArgs, setResumeArgs] = useState<string | null | undefined>(undefined)

  useEffect(() => {
    let active = true
    setResumeArgs(undefined)
    const resumeDetails = window.api.aiVault.resumeDetails
    // Why: renderer HMR can briefly run against an older Electron preload;
    // expanded details must remain usable until the app restarts that boundary.
    if (typeof resumeDetails !== 'function') {
      setResumeArgs(null)
      return () => {
        active = false
      }
    }
    // Why: captured argv is host-private until the user expands this row; the
    // host freshly revalidates and returns only the correlated argument suffix.
    void resumeDetails(buildAiVaultResumeEntry(session)).then(
      (result) => {
        if (active) {
          setResumeArgs(result.status === 'ok' ? sessionResumeArgsLabel(result.args) : null)
        }
      },
      () => {
        if (active) {
          setResumeArgs(null)
        }
      }
    )
    return () => {
      active = false
    }
  }, [session])

  return resumeArgs
}
