// @vitest-environment happy-dom

import { cleanup, renderHook } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import type { JiraProject, JiraSite } from '../../../../../shared/jira/jira-types'
import type { TaskPageJiraCreationStatePreludeModel } from './use-task-page-jira-creation-state'
import { useTaskPageJiraCreationProjects } from '@/components/task-page/jira/use-task-page-jira-creation-projects'

const sites: JiraSite[] = [
  {
    id: 'acme',
    siteUrl: 'https://acme.atlassian.net',
    email: 'ada@acme.com',
    displayName: 'Ada Lovelace',
    accountId: 'ada-acme'
  }
]
// Older remote hosts send the profile name alone as siteName.
const nameOnlyProject: JiraProject = {
  id: 'acme-project',
  key: 'ACME',
  name: 'Acme',
  siteId: 'acme',
  siteName: 'Ada Lovelace'
}

function useCreationProjectsFixture() {
  const noop = (): void => {}
  const model = {
    availableJiraIssueTypes: [],
    availableJiraProjects: [nameOnlyProject],
    jiraCreateFields: [],
    newJiraIssueCustomFieldValues: {},
    newJiraIssueProjectComboboxOpen: false,
    newJiraIssueProjectId: null,
    newJiraIssueProjectQuery: '',
    newJiraIssueProjectSearchInputRef: createRef<HTMLInputElement>(),
    newJiraIssueTypeId: null,
    selectedJiraSiteId: 'all',
    jiraSites: sites,
    providerRuntimeContextKey: 'site-label-test',
    setNewJiraIssueProjectComboboxOpen: noop,
    setNewJiraIssueProjectCommandValue: noop,
    setNewJiraIssueProjectId: noop,
    setNewJiraIssueProjectQuery: noop,
    setNewJiraIssueTypeId: noop
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture supplies every field read by the Jira project hook, without constructing unrelated task-page stages.
  return useTaskPageJiraCreationProjects(model as unknown as TaskPageJiraCreationStatePreludeModel)
}

describe('Jira creation project site labels', () => {
  afterEach(cleanup)

  it('relabels a name-only project siteName from its stored site', () => {
    const { result } = renderHook(() => useCreationProjectsFixture())

    expect(result.current.sortedAvailableJiraProjects.map((project) => project.siteName)).toEqual([
      'Ada Lovelace (acme.atlassian.net)'
    ])
  })
})
