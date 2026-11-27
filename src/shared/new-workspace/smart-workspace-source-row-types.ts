import type { GitHubWorkItem } from '../github/work-items/work-item-types'
import type { GitLabWorkItem } from '../gitlab/gitlab-types'
import type { ItsaplanIssue } from '../itsaplan/itsaplan-types'
import type { JiraIssue } from '../jira/jira-types'
import type { LinearIssue } from '../linear/issue-types'

export type SmartNameMode =
  | 'smart'
  | 'github'
  | 'gitlab'
  | 'branches'
  | 'linear'
  | 'jira'
  | 'itsaplan'
  | 'text'

export type SmartWorkspaceSourceRow =
  | { kind: 'use-name'; value: string; name: string }
  | { kind: 'create-branch'; value: string; name: string }
  | { kind: 'github'; value: string; item: GitHubWorkItem }
  | { kind: 'gitlab'; value: string; item: GitLabWorkItem }
  | { kind: 'branch'; value: string; refName: string; localBranchName: string; label?: string }
  | { kind: 'linear'; value: string; issue: LinearIssue }
  | { kind: 'jira'; value: string; issue: JiraIssue }
  | { kind: 'itsaplan'; value: string; issue: ItsaplanIssue }
