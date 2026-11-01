import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JiraIssue, JiraStatus, JiraTransition } from '../../../shared/jira/jira-types'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'

const mocks = vi.hoisted(() => ({
  jiraListTransitionsForTarget: vi.fn()
}))

vi.mock('@/runtime/runtime-jira-client', () => ({
  jiraListTransitionsForTarget: mocks.jiraListTransitionsForTarget
}))

const { findJiraBoardSectionTransition, loadTaskPageJiraIssueTransitions } =
  await import('./task-page-jira-board-transitions')
const target: RuntimeClientTarget = { kind: 'local' }

function status(id: string, name: string): JiraStatus {
  return { id, name, categoryKey: 'indeterminate', categoryName: 'In Progress' }
}

function transition(id: string, to: JiraStatus): JiraTransition {
  return { id, name: `To ${to.name}`, to }
}

function issue(key: string, statusValue: JiraStatus, siteId?: string): JiraIssue {
  return {
    id: key,
    key,
    siteId,
    title: key,
    url: `https://example.atlassian.net/browse/${key}`,
    project: { id: 'p1', key: 'STA', name: 'Stably' },
    issueType: { id: 't1', name: 'Task' },
    status: statusValue,
    labels: [],
    updatedAt: '2026-08-07T12:00:00.000Z',
    createdAt: '2026-08-07T12:00:00.000Z'
  }
}

describe('findJiraBoardSectionTransition', () => {
  const inProgress = status('2', 'In Progress')
  const done = status('3', 'Done')

  it('matches by the status id of issues already in the section', () => {
    const renamed = transition('t-done', { ...done, name: 'Completed' })
    const found = findJiraBoardSectionTransition([transition('t-ip', inProgress), renamed], {
      label: 'Done',
      issues: [issue('STA-1', done)]
    })
    expect(found).toBe(renamed)
  })

  it('matches an empty column through its board-config status ids', () => {
    const renamed = transition('t-done', { ...done, name: 'Completed' })
    const found = findJiraBoardSectionTransition([renamed], {
      label: 'Done column',
      statusIds: ['3'],
      issues: []
    })
    expect(found).toBe(renamed)
  })
  it('does not select an arbitrary action when several actions reach a column', () => {
    expect(
      findJiraBoardSectionTransition([transition('first', done), transition('second', done)], {
        label: 'Done',
        statusIds: ['3'],
        fromBoard: true,
        issues: []
      })
    ).toBeNull()
  })
  it('does not use a same-named status outside an authoritative board column', () => {
    expect(
      findJiraBoardSectionTransition([transition('other', status('other', 'Done'))], {
        label: 'Done',
        statusIds: ['3'],
        fromBoard: true,
        issues: []
      })
    ).toBeNull()
  })
  it('does not borrow a status ID from another Jira site in fallback columns', () => {
    expect(
      findJiraBoardSectionTransition(
        [transition('wrong', status('3', 'Blocked'))],
        {
          label: 'Done',
          statusIds: ['3'],
          fromBoard: false,
          issues: [issue('ABC-1', done, 'site-b')]
        },
        'site-a'
      )
    ).toBeNull()
  })
})

describe('loadTaskPageJiraIssueTransitions', () => {
  beforeEach(() => {
    mocks.jiraListTransitionsForTarget.mockReset()
  })

  it('caches per issue status and refetches after the status changes', async () => {
    const inProgress = status('2', 'In Progress')
    const done = status('3', 'Done')
    mocks.jiraListTransitionsForTarget.mockResolvedValue([transition('t-done', done)])

    await loadTaskPageJiraIssueTransitions(target, 'scope', issue('STA-9', inProgress, 'site-a'))
    await loadTaskPageJiraIssueTransitions(target, 'scope', issue('STA-9', inProgress, 'site-a'))
    expect(mocks.jiraListTransitionsForTarget).toHaveBeenCalledTimes(1)

    await loadTaskPageJiraIssueTransitions(target, 'scope', issue('STA-9', done, 'site-a'))
    expect(mocks.jiraListTransitionsForTarget).toHaveBeenCalledTimes(2)
  })

  it('surfaces a failed transitions request and allows an explicit retry', async () => {
    mocks.jiraListTransitionsForTarget.mockRejectedValue(new Error('offline'))
    await expect(
      loadTaskPageJiraIssueTransitions(
        target,
        'scope',
        issue('STA-500', status('2', 'In Progress'))
      )
    ).rejects.toThrow('offline')
    mocks.jiraListTransitionsForTarget.mockResolvedValue([])
    await expect(
      loadTaskPageJiraIssueTransitions(
        target,
        'scope',
        issue('STA-500', status('2', 'In Progress')),
        true
      )
    ).resolves.toEqual([])
    expect(mocks.jiraListTransitionsForTarget).toHaveBeenCalledTimes(2)
  })

  it('keeps concurrent local and remote metadata apart even with the same scope', async () => {
    const remote: RuntimeClientTarget = { kind: 'environment', environmentId: 'owner' }
    const currentIssue = issue('STA-OWNER', status('2', 'In Progress'), 'site-a')
    const localAction = transition('local-done', status('3', 'Done'))
    const remoteAction = transition('remote-done', status('3', 'Done'))
    mocks.jiraListTransitionsForTarget.mockImplementation((owner: RuntimeClientTarget) =>
      Promise.resolve(owner.kind === 'local' ? [localAction] : [remoteAction])
    )
    await expect(
      Promise.all([
        loadTaskPageJiraIssueTransitions(target, 'same-scope', currentIssue),
        loadTaskPageJiraIssueTransitions(remote, 'same-scope', currentIssue)
      ])
    ).resolves.toEqual([[localAction], [remoteAction]])
    await expect(
      loadTaskPageJiraIssueTransitions(remote, 'same-scope', currentIssue)
    ).resolves.toEqual([remoteAction])
    expect(mocks.jiraListTransitionsForTarget).toHaveBeenCalledTimes(2)
    expect(mocks.jiraListTransitionsForTarget).toHaveBeenCalledWith(
      remote,
      currentIssue.key,
      currentIssue.siteId
    )
  })
})
