import type { JiraIssue, JiraTransition } from '../../../shared/jira-types'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { jiraListTransitionsForTarget } from '@/runtime/runtime-jira-client'
import { getRuntimeTargetHostId } from '@/runtime/runtime-client-target'
import { createMetadataRequestStore, loadMetadata } from '@/hooks/metadata-request-cache'
import type { TaskPageJiraBoardSection } from './task-page-jira-board-sections'

const jiraIssueTransitionsStore = createMetadataRequestStore<JiraTransition[]>()

export function loadTaskPageJiraIssueTransitions(
  target: RuntimeClientTarget,
  runtimeScopeKey: string,
  issue: Pick<JiraIssue, 'key' | 'siteId' | 'status'>,
  force = false
): Promise<JiraTransition[]> {
  // Status changes invalidate transitions without borrowing another owner's cache.
  const cacheKey = [
    encodeURIComponent(getRuntimeTargetHostId(target)),
    encodeURIComponent(runtimeScopeKey),
    encodeURIComponent(issue.siteId ?? ''),
    encodeURIComponent(issue.key),
    encodeURIComponent(issue.status.id)
  ].join(':')
  if (force) {
    jiraIssueTransitionsStore.cache.delete(cacheKey)
    jiraIssueTransitionsStore.failures.delete(cacheKey)
  }
  return loadMetadata(jiraIssueTransitionsStore, cacheKey, () =>
    jiraListTransitionsForTarget(target, issue.key, issue.siteId)
  )
}

export function findJiraBoardSectionTransition(
  transitions: readonly JiraTransition[],
  section: Pick<TaskPageJiraBoardSection, 'label' | 'issues'> &
    Partial<Pick<TaskPageJiraBoardSection, 'statusIds' | 'fromBoard'>>,
  siteId?: string
): JiraTransition | null {
  const matches = findJiraBoardSectionTransitions(transitions, section, siteId)
  return matches.length === 1 ? matches[0] : null
}

export function findJiraBoardSectionTransitions(
  transitions: readonly JiraTransition[],
  section: Pick<TaskPageJiraBoardSection, 'label' | 'issues'> &
    Partial<Pick<TaskPageJiraBoardSection, 'statusIds' | 'fromBoard'>>,
  siteId?: string
): JiraTransition[] {
  const statusIds = new Set(section.fromBoard === false ? [] : (section.statusIds ?? []))
  for (const issue of section.issues) {
    if (!siteId || issue.siteId === siteId) {
      statusIds.add(issue.status.id)
    }
  }
  const matches = transitions.filter((transition) => statusIds.has(transition.to.id))
  return matches.length > 0 || section.fromBoard
    ? matches
    : transitions.filter((transition) => transition.to.name === section.label)
}
