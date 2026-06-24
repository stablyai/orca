import { describe, expect, it } from 'vitest'
import { normalizeFolderWorkspaceLinkedTask } from './folder-workspaces'

describe('normalizeFolderWorkspaceLinkedTask', () => {
  it('preserves concrete GitHub issue source preference', () => {
    expect(
      normalizeFolderWorkspaceLinkedTask({
        provider: 'github',
        type: 'issue',
        number: 42,
        title: 'Refund flow fails',
        url: 'https://github.com/acme/app/issues/42',
        issueSourcePreference: 'origin'
      })
    ).toMatchObject({ issueSourcePreference: 'origin' })
  })

  it('drops issue source preference for non-GitHub issue tasks', () => {
    expect(
      normalizeFolderWorkspaceLinkedTask({
        provider: 'github',
        type: 'pr',
        number: 42,
        title: 'Refund flow fails',
        url: 'https://github.com/acme/app/pull/42',
        issueSourcePreference: 'origin'
      })
    ).not.toHaveProperty('issueSourcePreference')
  })

  it('preserves GitLab project refs for linked GitLab tasks', () => {
    expect(
      normalizeFolderWorkspaceLinkedTask({
        provider: 'gitlab',
        type: 'issue',
        number: 7,
        title: 'Import fails',
        url: 'https://gitlab.example.com/group/project/-/issues/7',
        gitLabProjectRef: { host: ' gitlab.example.com ', path: ' group/project ' }
      })
    ).toMatchObject({
      gitLabProjectRef: { host: 'gitlab.example.com', path: 'group/project' }
    })
  })
})
