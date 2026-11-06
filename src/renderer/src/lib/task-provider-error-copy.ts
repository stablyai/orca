import type { TaskProviderErrorCode } from '../../../shared/task-provider-failure'
import { translate } from '@/i18n/i18n'
import { displayIpcErrorMessage } from './ipc-error'

const COPY: Record<TaskProviderErrorCode, () => string> = {
  'linear.issuesLoadFailed': () =>
    translate('taskProviders.linear.issuesLoadFailed', 'Failed to load Linear issues.'),
  'linear.notConnected': () =>
    translate('taskProviders.errors.linear.notConnected', 'Not connected to Linear'),
  'linear.createFailed': () =>
    translate('taskProviders.errors.linear.createFailed', 'Linear create failed'),
  'linear.createdButUnavailable': () =>
    translate(
      'taskProviders.errors.linear.createdButUnavailable',
      'Issue was created but could not be retrieved'
    ),
  'linear.updateFailed': () =>
    translate('taskProviders.errors.linear.updateFailed', 'Linear update failed'),
  'linear.commentFailed': () =>
    translate('taskProviders.errors.linear.commentFailed', 'Failed to create comment'),
  'linear.projectCreateFailed': () =>
    translate('taskProviders.errors.linear.projectCreateFailed', 'Linear project create failed'),
  'linear.noApiKey': () => translate('taskProviders.errors.linear.noApiKey', 'No API key stored.'),
  'linear.workspaceAuthExpired': () =>
    translate(
      'taskProviders.errors.linear.workspaceAuthExpired',
      'Linear authentication expired for this workspace.'
    ),
  'linear.projectNameRequired': () =>
    translate('taskProviders.errors.linear.projectNameRequired', 'Project name is required'),
  'linear.projectIdRequired': () =>
    translate('taskProviders.errors.linear.projectIdRequired', 'Project ID is required'),
  'linear.projectNotFound': () =>
    translate('taskProviders.errors.linear.projectNotFound', 'Project was not found'),
  'linear.viewIdRequired': () =>
    translate('taskProviders.errors.linear.viewIdRequired', 'Custom view ID is required'),
  'linear.viewHasNoIssues': () =>
    translate('taskProviders.errors.linear.viewHasNoIssues', 'Custom view does not contain issues'),
  'linear.viewHasNoProjects': () =>
    translate(
      'taskProviders.errors.linear.viewHasNoProjects',
      'Custom view does not contain projects'
    ),
  'jira.notConnected': () =>
    translate('taskProviders.errors.jira.notConnected', 'Not connected to Jira.'),
  'jira.titleRequired': () =>
    translate('taskProviders.errors.jira.titleRequired', 'Title is required.'),
  'jira.labelsConflict': () =>
    translate(
      'taskProviders.errors.jira.labelsConflict',
      'Pass labels or labelOperations, not both.'
    ),
  'jira.createFailed': () =>
    translate('taskProviders.errors.jira.createFailed', 'Failed to create issue.'),
  'jira.updateFailed': () =>
    translate('taskProviders.errors.jira.updateFailed', 'Failed to update issue.'),
  'jira.commentFailed': () =>
    translate('taskProviders.errors.jira.commentFailed', 'Failed to add comment.'),
  'jira.credentialsRequired': () =>
    translate(
      'taskProviders.errors.jira.credentialsRequired',
      'Site URL, email, and API token are required.'
    ),
  'jira.projectRequired': () =>
    translate('taskProviders.errors.jira.projectRequired', 'Project is required.'),
  'jira.issueTypeRequired': () =>
    translate('taskProviders.errors.jira.issueTypeRequired', 'Issue type is required.'),
  'jira.issueKeyRequired': () =>
    translate('taskProviders.errors.jira.issueKeyRequired', 'Issue key is required.'),
  'jira.updatesRequired': () =>
    translate('taskProviders.errors.jira.updatesRequired', 'Updates object is required.'),
  'jira.commentBodyRequired': () =>
    translate('taskProviders.errors.jira.commentBodyRequired', 'Comment body is required.'),
  'jira.invalidSiteUrl': () =>
    translate('taskProviders.errors.jira.invalidSiteUrl', 'Enter a valid Jira site URL.'),
  'jira.passwordRequired': () =>
    translate('taskProviders.errors.jira.passwordRequired', 'Password is required.'),
  'jira.personalTokenRequired': () =>
    translate(
      'taskProviders.errors.jira.personalTokenRequired',
      'Personal access token is required.'
    ),
  'jira.apiTokenRequired': () =>
    translate('taskProviders.errors.jira.apiTokenRequired', 'API token is required.'),
  'jira.connectionFailed': () =>
    translate('taskProviders.errors.jira.connectionFailed', 'Connection failed.'),
  'jira.invalidSiteIdentity': () =>
    translate(
      'taskProviders.errors.jira.invalidSiteIdentity',
      'Enter an HTTP or HTTPS Jira site URL without credentials.'
    ),
  'jira.missingProjectIdentity': () =>
    translate(
      'taskProviders.errors.jira.missingProjectIdentity',
      'Jira returned a project without an ID or key.'
    ),
  'jira.invalidIssuePage': () =>
    translate('taskProviders.errors.jira.invalidIssuePage', 'Jira returned an invalid issue page.'),
  'jira.incompleteIssuePage': () =>
    translate(
      'taskProviders.errors.jira.incompleteIssuePage',
      'Jira returned an incomplete issue page.'
    ),
  'jira.repeatedIssueToken': () =>
    translate(
      'taskProviders.errors.jira.repeatedIssueToken',
      'Jira returned an invalid or repeated issue page token.'
    ),
  'jira.issueSearchLimit': () =>
    translate(
      'taskProviders.errors.jira.issueSearchLimit',
      'Jira issue search exceeded the page limit. Select a project with JQL instead.'
    ),
  'jira.invalidProjectPage': () =>
    translate(
      'taskProviders.errors.jira.invalidProjectPage',
      'Jira returned an invalid project page.'
    ),
  'jira.incompleteProjectPage': () =>
    translate(
      'taskProviders.errors.jira.incompleteProjectPage',
      'Jira returned an incomplete project page.'
    ),
  'jira.projectListLimit': () =>
    translate(
      'taskProviders.errors.jira.projectListLimit',
      'Jira project list exceeded the page limit. Select a project with JQL instead.'
    ),
  'jira.invalidCloudId': () =>
    translate(
      'taskProviders.errors.jira.invalidCloudId',
      'The site did not report a valid Atlassian cloud ID.'
    )
}

const LEGACY_CODES: Record<string, TaskProviderErrorCode> = {
  'Failed to load Linear issues.': 'linear.issuesLoadFailed',
  'Not connected to Linear': 'linear.notConnected',
  'Linear create failed': 'linear.createFailed',
  'Issue was created but could not be retrieved': 'linear.createdButUnavailable',
  'Linear update failed': 'linear.updateFailed',
  'Failed to create comment': 'linear.commentFailed',
  'Linear project create failed': 'linear.projectCreateFailed',
  'No API key stored.': 'linear.noApiKey',
  'Linear authentication expired for this workspace.': 'linear.workspaceAuthExpired',
  'Project name is required': 'linear.projectNameRequired',
  'Project ID is required': 'linear.projectIdRequired',
  'Project was not found': 'linear.projectNotFound',
  'Custom view ID is required': 'linear.viewIdRequired',
  'Custom view does not contain issues': 'linear.viewHasNoIssues',
  'Custom view does not contain projects': 'linear.viewHasNoProjects',
  'Not connected to Jira.': 'jira.notConnected',
  'Title is required.': 'jira.titleRequired',
  'Pass labels or labelOperations, not both.': 'jira.labelsConflict',
  'Failed to create issue.': 'jira.createFailed',
  'Failed to update issue.': 'jira.updateFailed',
  'Failed to add comment.': 'jira.commentFailed',
  'Site URL, email, and API token are required.': 'jira.credentialsRequired',
  'Project is required.': 'jira.projectRequired',
  'Issue type is required.': 'jira.issueTypeRequired',
  'Issue key is required.': 'jira.issueKeyRequired',
  'Updates object is required.': 'jira.updatesRequired',
  'Comment body is required.': 'jira.commentBodyRequired',
  'Enter a valid Jira site URL.': 'jira.invalidSiteUrl',
  'Password is required.': 'jira.passwordRequired',
  'Personal access token is required.': 'jira.personalTokenRequired',
  'API token is required.': 'jira.apiTokenRequired',
  'Connection failed.': 'jira.connectionFailed',
  'Enter an HTTP or HTTPS Jira site URL without credentials.': 'jira.invalidSiteIdentity',
  'Jira returned a project without an ID or key.': 'jira.missingProjectIdentity',
  'Jira returned an invalid issue page.': 'jira.invalidIssuePage',
  'Jira returned an incomplete issue page.': 'jira.incompleteIssuePage',
  'Jira returned an invalid or repeated issue page token.': 'jira.repeatedIssueToken',
  'Jira issue search exceeded the page limit. Select a project with JQL instead.':
    'jira.issueSearchLimit',
  'Jira returned an invalid project page.': 'jira.invalidProjectPage',
  'Jira returned an incomplete project page.': 'jira.incompleteProjectPage',
  'Jira project list exceeded the page limit. Select a project with JQL instead.':
    'jira.projectListLimit',
  'The site did not report a valid Atlassian cloud ID.': 'jira.invalidCloudId'
}

function isTaskProviderErrorCode(code: unknown): code is TaskProviderErrorCode {
  return typeof code === 'string' && Object.hasOwn(COPY, code)
}

export function taskProviderErrorText(error: unknown, errorCode?: unknown): string {
  const raw = typeof error === 'string' ? error : ''
  const message = displayIpcErrorMessage(raw) ?? raw
  const code = isTaskProviderErrorCode(errorCode)
    ? errorCode
    : Object.hasOwn(LEGACY_CODES, message)
      ? LEGACY_CODES[message]
      : undefined
  return code === undefined ? raw : COPY[code]()
}

export function taskProviderErrorMessage(result: { error?: unknown; errorCode?: unknown }): string {
  return taskProviderErrorText(result.error, result.errorCode)
}
