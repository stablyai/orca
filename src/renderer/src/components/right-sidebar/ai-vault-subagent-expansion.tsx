import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'

type Expansion = {
  expanded: ReadonlySet<string>
  setExpanded: (key: string, open: boolean) => void
}

const SubagentExpansionContext = createContext<Expansion | null>(null)

export function subagentTranscriptKey(session: AiVaultSession): string {
  return JSON.stringify([
    session.executionHostId,
    session.agent,
    normalizeRuntimePathForComparison(session.filePath)
  ])
}

export function SubagentExpansionProvider({
  children
}: {
  children: ReactNode
}): React.JSX.Element {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())

  const value = useMemo<Expansion>(
    () => ({
      expanded,
      setExpanded: (key, open) =>
        setExpanded((current) => {
          const next = new Set(current)

          if (open) {
            next.add(key)
          } else {
            next.delete(key)
          }

          return next
        })
    }),
    [expanded]
  )

  return (
    <SubagentExpansionContext.Provider value={value}>{children}</SubagentExpansionContext.Provider>
  )
}

export function useSubagentExpansion(): Expansion | null {
  return useContext(SubagentExpansionContext)
}
