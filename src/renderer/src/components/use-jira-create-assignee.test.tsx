// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useJiraCreateAssignee } from './use-jira-create-assignee'

const user = { accountId: 'account-a', displayName: 'Ada' }

describe('useJiraCreateAssignee', () => {
  it('clears the selection when a site filter implicitly changes the target project', () => {
    const { result, rerender } = renderHook(
      ({ project }) => useJiraCreateAssignee('local', project),
      { initialProps: { project: 'site-a::100' } }
    )
    act(() => result.current.setNewJiraIssueAssignee(user))
    const staleSelect = result.current.setNewJiraIssueAssignee
    rerender({ project: 'site-b::100' })
    expect(result.current.newJiraIssueAssignee).toBeNull()
    act(() => staleSelect(user))
    expect(result.current.newJiraIssueAssignee).toBeNull()
    rerender({ project: 'site-a::100' })
    expect(result.current.newJiraIssueAssignee).toBeNull()
  })

  it('clears across providers even when the dialog was closed', () => {
    const { result, rerender } = renderHook(
      ({ provider }) => useJiraCreateAssignee(provider, 'site-a::100'),
      { initialProps: { provider: 'local' } }
    )
    act(() => result.current.setNewJiraIssueAssignee(user))
    rerender({ provider: 'runtime:remote' })
    expect(result.current.newJiraIssueAssignee).toBeNull()
  })

  it('retains the assignee across unrelated renders and supports Automatic', () => {
    const { result, rerender } = renderHook(() => useJiraCreateAssignee('local', 'site-a::100'))
    act(() => result.current.setNewJiraIssueAssignee(user))
    rerender()
    expect(result.current.newJiraIssueAssignee).toEqual(user)
    act(() => result.current.setNewJiraIssueAssignee(null))
    expect(result.current.newJiraIssueAssignee).toBeNull()
  })
})
