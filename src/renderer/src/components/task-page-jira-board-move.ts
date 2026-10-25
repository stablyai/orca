import type {
  JiraIssue,
  JiraIssueUpdate,
  JiraMutationResult,
  JiraTransition
} from '../../../shared/jira/jira-types'
import type { TaskPageJiraBoardSection } from './task-page-jira-board-sections'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import {
  findJiraBoardSectionTransitions,
  loadTaskPageJiraIssueTransitions
} from './task-page-jira-board-transitions'
import { jiraGetIssueForTarget, jiraUpdateIssueForTarget } from '@/runtime/runtime-jira-client'

export async function getJiraBoardMoveTransitions(
  target: RuntimeClientTarget,
  scopeKey: string,
  issue: JiraIssue,
  destination: TaskPageJiraBoardSection,
  force = false
): Promise<JiraTransition[]> {
  const transitions = await loadTaskPageJiraIssueTransitions(target, scopeKey, issue, force)
  return findJiraBoardSectionTransitions(transitions, destination, issue.siteId)
}

export async function applyJiraBoardMove(
  target: RuntimeClientTarget,
  issue: JiraIssue,
  updates: JiraIssueUpdate
): Promise<{ result: JiraMutationResult; latest: JiraIssue | null }> {
  const result = await jiraUpdateIssueForTarget(target, issue.key, updates, issue.siteId)
  if (!result.ok) {
    return { result, latest: null }
  }
  const latest = await jiraGetIssueForTarget(target, issue.key, issue.siteId).catch(() => null)
  return { result, latest }
}
