import type { JiraIssue, JiraTransition } from '../../../shared/types'
import { jiraListTransitions, type RuntimeJiraSettings } from '@/runtime/runtime-jira-client'
import { createMetadataRequestStore, loadMetadata } from '@/hooks/metadata-request-cache'
import type { TaskPageJiraBoardSection } from './task-page-jira-board-sections'

const jiraIssueTransitionsStore = createMetadataRequestStore<JiraTransition[]>()

export function loadTaskPageJiraIssueTransitions(
  settings: RuntimeJiraSettings,
  runtimeScopeKey: string,
  issue: Pick<JiraIssue, 'key' | 'siteId' | 'status'>
): Promise<JiraTransition[]> {
  // Why: the current status participates in the key so a moved issue naturally
  // misses the stale entry instead of reusing transitions from its old status.
  const cacheKey = [
    encodeURIComponent(runtimeScopeKey),
    encodeURIComponent(issue.siteId ?? ''),
    encodeURIComponent(issue.key),
    encodeURIComponent(issue.status.id)
  ].join(':')
  return loadMetadata(jiraIssueTransitionsStore, cacheKey, () =>
    jiraListTransitions(settings, issue.key, issue.siteId)
  ).catch((error: unknown) => {
    console.warn('[jira] Failed to load issue transitions:', error)
    return []
  })
}

export function findJiraBoardSectionTransition(
  transitions: readonly JiraTransition[],
  section: Pick<TaskPageJiraBoardSection, 'label' | 'issues'> &
    Partial<Pick<TaskPageJiraBoardSection, 'statusIds'>>
): JiraTransition | null {
  // Why: board-config status ids are authoritative (they let empty columns
  // receive drops); ids from the section's issues and the name match cover
  // boards without column metadata.
  const sectionStatusIds = new Set(section.statusIds ?? [])
  for (const issue of section.issues) {
    sectionStatusIds.add(issue.status.id)
  }
  return (
    transitions.find((transition) => sectionStatusIds.has(transition.to.id)) ??
    transitions.find((transition) => transition.to.name === section.label) ??
    null
  )
}
