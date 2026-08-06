// @vitest-environment happy-dom

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ClaudeManagedAccountSummary, Project } from '../../../../shared/types'
import { ProjectClaudeAccountSetting } from './ProjectClaudeAccountSetting'

const project: Project = {
  id: 'project-1',
  displayName: 'Example Project',
  badgeColor: '#000000',
  sourceRepoIds: ['repo-1'],
  createdAt: 1,
  updatedAt: 1
}

const accounts: ClaudeManagedAccountSummary[] = [
  {
    id: 'acct-host',
    email: 'host@example.com',
    authMethod: 'subscription-oauth',
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1
  },
  {
    id: 'acct-wsl',
    email: 'wsl@example.com',
    managedAuthRuntime: 'wsl',
    wslDistro: 'Ubuntu',
    authMethod: 'subscription-oauth',
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1
  }
]

describe('ProjectClaudeAccountSetting', () => {
  it('describes the inherited global account when no override is set', () => {
    const markup = renderToStaticMarkup(
      <ProjectClaudeAccountSetting project={project} accounts={accounts} updateProject={vi.fn()} />
    )

    expect(markup).toContain('Claude account')
    expect(markup).toContain('No project override. Claude Code uses the globally selected account.')
    expect(markup).toContain('Default (follow global account)')
    expect(markup).toContain('running terminals keep their current account')
  })

  it('describes the project override and selects the preferred account', () => {
    const markup = renderToStaticMarkup(
      <ProjectClaudeAccountSetting
        project={{
          ...project,
          claudeAccountPreference: { kind: 'account', accountId: 'acct-host' }
        }}
        accounts={accounts}
        updateProject={vi.fn()}
      />
    )

    expect(markup).toContain('Claude Code launches in this project switch to this account first.')
    expect(markup).toContain('host@example.com')
  })

  it('surfaces a removed account so the user can clear it', () => {
    const markup = renderToStaticMarkup(
      <ProjectClaudeAccountSetting
        project={{
          ...project,
          claudeAccountPreference: { kind: 'account', accountId: 'gone' }
        }}
        accounts={accounts}
        updateProject={vi.fn()}
      />
    )

    expect(markup).toContain('Removed account')
  })
})
