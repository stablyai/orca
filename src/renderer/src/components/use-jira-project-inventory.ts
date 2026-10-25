import { useEffect, useState } from 'react'
import type { JiraProject } from '../../../shared/jira/jira-types'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import { taskSourceRuntimeTarget } from '@/lib/task-source-runtime-target'
import {
  jiraListProjectsForTarget,
  jiraStatusForTarget
} from '@/runtime/runtime-jira-project-client'

type JiraProjectInventorySource = RuntimeClientTarget | TaskSourceContext

export function useJiraProjectInventory(source: JiraProjectInventorySource, enabled: boolean) {
  const [inventory, setInventory] = useState<{
    source: JiraProjectInventorySource
    projects: JiraProject[]
    connected: boolean
    error: string | null
  } | null>(null)
  useEffect(() => {
    if (!enabled) {
      return
    }
    let cancelled = false
    const target = source.kind === 'task-source' ? taskSourceRuntimeTarget(source) : source
    void jiraStatusForTarget(target)
      .then(async (status) => ({
        source,
        connected: status.connected,
        projects: status.connected ? await jiraListProjectsForTarget(target, 'all') : [],
        error: null
      }))
      .then((next) => {
        if (!cancelled) {
          setInventory(next)
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setInventory({
            source,
            connected: false,
            projects: [],
            error: error instanceof Error ? error.message : String(error)
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [source, enabled])
  const current = inventory?.source === source ? inventory : null
  return {
    projects: current?.projects ?? [],
    connected: current?.connected ?? false,
    error: current?.error ?? null,
    loading: enabled && current === null
  }
}
