import { useState } from 'react'
import type { AiVaultScope } from '../../../../shared/ai-vault-types'

/** A query belongs to the workspace or project it searched: moving to another clears it, picking a scope keeps it. */
export function useAiVaultPanelQuery(
  initialQuery: string,
  {
    preferredScope,
    activeWorktreeId,
    activeProjectKey
  }: {
    preferredScope: AiVaultScope
    activeWorktreeId: string | null
    activeProjectKey: string | null
  }
) {
  const subject = { workspace: activeWorktreeId, project: activeProjectKey, all: null }[
    preferredScope
  ]
  const [query, setQuery] = useState(initialQuery)
  const [typedFor, setTypedFor] = useState({ scope: preferredScope, subject })
  // Adjusted during render so the new workspace never paints, or searches, the old query.
  if (typedFor.scope !== preferredScope || typedFor.subject !== subject) {
    setTypedFor({ scope: preferredScope, subject })
    if (typedFor.scope === preferredScope) {
      setQuery('')
    }
  }
  return [query, setQuery] as const
}
