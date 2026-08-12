import { useEffect, useRef } from 'react'
import type { Repo } from '../../../../shared/types'
import type { RepoAgentSessionRuleOverrides } from '../../../../shared/agent-session-rules-types'
import { normalizeRepoAgentSessionRuleOverrides } from '../../../../shared/agent-session-rules'

export type RepositoryAgentSessionRulesPatch =
  | Partial<RepoAgentSessionRuleOverrides>
  | ((current: RepoAgentSessionRuleOverrides) => Partial<RepoAgentSessionRuleOverrides>)

export function useRepositoryAgentSessionRulesWriter(args: {
  repo: Repo
  updateRepo: (
    repoId: string,
    updates: { agentSessionRules?: RepoAgentSessionRuleOverrides | null }
  ) => void | Promise<boolean>
}): (patch: RepositoryAgentSessionRulesPatch) => Promise<boolean> {
  const overridesRef = useRef(
    normalizeRepoAgentSessionRuleOverrides(args.repo.agentSessionRules) ?? {}
  )
  const committedOverridesRef = useRef(overridesRef.current)
  const pendingWritesRef = useRef(0)
  const writeRevisionRef = useRef(0)
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve())

  useEffect(() => {
    if (pendingWritesRef.current === 0) {
      overridesRef.current =
        normalizeRepoAgentSessionRuleOverrides(args.repo.agentSessionRules) ?? {}
      committedOverridesRef.current = overridesRef.current
    }
  }, [args.repo.agentSessionRules])

  return (patch): Promise<boolean> => {
    const current = overridesRef.current
    const resolved = typeof patch === 'function' ? patch(current) : patch
    const next = normalizeRepoAgentSessionRuleOverrides({ ...current, ...resolved }) ?? null
    const revision = ++writeRevisionRef.current
    overridesRef.current = next ?? {}
    pendingWritesRef.current += 1
    const write = writeQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        const saved = (await args.updateRepo(args.repo.id, { agentSessionRules: next })) !== false
        if (saved) {
          committedOverridesRef.current = next ?? {}
        } else if (revision === writeRevisionRef.current) {
          overridesRef.current = committedOverridesRef.current
        }
        return saved
      })
    writeQueueRef.current = write
      .then(() => undefined)
      .finally(() => {
        pendingWritesRef.current -= 1
      })
      .catch(() => undefined)
    return write.catch(() => false)
  }
}
