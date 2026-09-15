// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AtlassianTokenScopeList } from './atlassian-token-scope-list'
import { jiraTokenScopeGroups } from './jira-token-scopes'
import { bitbucketTokenScopeGroups } from './settings/bitbucket-token-scopes'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, options?: Record<string, string>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => options?.[name] ?? '')
}))

const writeClipboardText = vi.fn(async () => undefined)

afterEach(cleanup)

beforeEach(() => {
  writeClipboardText.mockClear()
  Object.assign(window, { api: { ui: { writeClipboardText } } })
})

describe('AtlassianTokenScopeList', () => {
  it('copies a single scope when it is clicked', async () => {
    render(<AtlassianTokenScopeList groups={jiraTokenScopeGroups()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Copy write:jira-work' }))

    await waitFor(() => expect(writeClipboardText).toHaveBeenCalledWith('write:jira-work'))
  })

  it('copies a whole group one scope per line', async () => {
    render(<AtlassianTokenScopeList groups={bitbucketTokenScopeGroups()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Copy all Verify and read scopes' }))

    await waitFor(() =>
      expect(writeClipboardText).toHaveBeenCalledWith(
        'read:user:bitbucket\nread:repository:bitbucket\nread:pullrequest:bitbucket'
      )
    )
  })
})

describe('Atlassian token scope groups', () => {
  it('lists the Jira scopes, with board column order optional', () => {
    expect(
      jiraTokenScopeGroups().map((group) => ({ label: group.label, scopes: group.scopes }))
    ).toEqual([
      { label: 'Required', scopes: ['read:jira-work', 'write:jira-work', 'read:jira-user'] },
      {
        label: 'Board column order (optional)',
        scopes: [
          'read:board-scope:jira-software',
          'read:board-scope.admin:jira-software',
          'read:project:jira'
        ]
      }
    ])
  })

  it('lists the Bitbucket scopes for reading and for creating pull requests', () => {
    expect(
      bitbucketTokenScopeGroups().map((group) => ({ label: group.label, scopes: group.scopes }))
    ).toEqual([
      {
        label: 'Verify and read',
        scopes: ['read:user:bitbucket', 'read:repository:bitbucket', 'read:pullrequest:bitbucket']
      },
      { label: 'Create pull requests', scopes: ['write:pullrequest:bitbucket'] }
    ])
  })
})
