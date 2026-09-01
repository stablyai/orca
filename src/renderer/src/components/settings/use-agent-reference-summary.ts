import { useEffect, useState } from 'react'
import type { CustomTuiAgentId } from '../../../../shared/types'
import type { AgentReferenceSummary } from '../../../../shared/agent-reference-snapshot'

/**
 * Fetch the desktop-only per-owner reference summary for a custom agent while a
 * confirmation dialog is open. Owner kind + count only — never prompt/config/env.
 * Returns `null` until the first load resolves (or if it fails, so the dialog can
 * degrade to no count rather than block the destructive action).
 */
export function useAgentReferenceSummary(
  id: CustomTuiAgentId | null,
  open: boolean
): { summary: AgentReferenceSummary[] | null; loading: boolean } {
  const [summary, setSummary] = useState<AgentReferenceSummary[] | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open || !id) {
      setSummary(null)
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    void window.api.settings.agentCatalog
      .referenceSummary({ id })
      .then((rows) => {
        if (!cancelled) {
          setSummary(rows)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSummary(null)
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [id, open])

  return { summary, loading }
}
