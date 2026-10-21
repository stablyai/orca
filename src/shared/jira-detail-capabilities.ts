import { JIRA_IMAGE_CAPABILITY } from './jira-attachment-image'

export const JIRA_ISSUE_SUMMARY_RUNTIME_CAPABILITY = 'jira.issue-summary-generation.v1' as const
export const JIRA_USER_FIELDS_RUNTIME_CAPABILITY = 'jira.user-fields.v1' as const
export const JIRA_TRANSITION_FIELDS_RUNTIME_CAPABILITY = 'jira.transition-fields.v1' as const
export const JIRA_CURRENT_SPRINT_RUNTIME_CAPABILITY = 'jira.current-sprint.v1' as const
export const JIRA_USER_FIELDS_UPDATE_REQUIRED_MESSAGE =
  'Creating Jira issues with user fields requires a newer Orca server. Update the server and try again.'

export const JIRA_DETAIL_RUNTIME_CAPABILITIES = [
  JIRA_USER_FIELDS_RUNTIME_CAPABILITY,
  JIRA_IMAGE_CAPABILITY,
  JIRA_ISSUE_SUMMARY_RUNTIME_CAPABILITY
] as const
