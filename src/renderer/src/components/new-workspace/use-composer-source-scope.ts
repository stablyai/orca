import { useState } from 'react'
import type { Repo } from '../../../../shared/repo-types'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'

export function useComposerSourceScope<T>(
  repo: Repo | null,
  source: TaskSourceContext | null,
  defaultValue: T
) {
  const scopeKey = JSON.stringify([
    repo ? getRepoExecutionHostId(repo) : null,
    repo?.id ?? null,
    repo?.path ?? null,
    source?.hostId ?? null,
    source?.projectId ?? null,
    source?.projectHostSetupId ?? null
  ])
  const [override, setOverride] = useState<{ scopeKey: string; value: T } | null>(null)
  const value = override?.scopeKey === scopeKey ? override.value : defaultValue
  const setValue = (next: T) => setOverride({ scopeKey, value: next })
  return [value, setValue] as const
}
