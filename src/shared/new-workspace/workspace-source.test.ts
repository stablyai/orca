import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildJiraWorkspaceSource,
  buildLinearWorkspaceSource,
  buildPluginWorkspaceSource,
  buildWorkspaceSourceSelection,
  getWorkspaceSourceName,
  getWorkspaceSourceProvider,
  shouldApplyWorkspaceSourceAutoName,
  shouldPreserveWorkspaceSourceOnRepoChange
} from './workspace-source'

describe('workspace source policy', () => {
  const linear = buildLinearWorkspaceSource({
    identifier: 'ENG-42',
    title: 'Ship mobile parity',
    url: 'https://linear.app/acme/issue/ENG-42/ship-mobile-parity',
    workspaceId: 'workspace-1',
    branchName: '  team/eng-42-ship-mobile-parity  '
  })

  it('builds one Linear identity for desktop and mobile create flows', () => {
    expect(linear).toMatchObject({
      provider: 'linear',
      number: 0,
      linearIdentifier: 'ENG-42',
      linearWorkspaceId: 'workspace-1',
      linearOrganizationUrlKey: 'acme',
      linearBranchName: 'team/eng-42-ship-mobile-parity'
    })
    expect(getWorkspaceSourceName(linear)).toEqual({
      seedName: 'eng-42-ship-mobile-parity',
      displayName: 'ENG-42 Ship mobile parity'
    })
  })

  it('persists a Jira title without repeating its separately stored identifier', () => {
    expect(
      buildJiraWorkspaceSource({
        key: 'ORCA-123',
        title: 'Fix Jira card details',
        url: 'https://company.atlassian.net/browse/ORCA-123'
      })
    ).toEqual({
      provider: 'jira',
      type: 'issue',
      number: 0,
      title: 'Fix Jira card details',
      url: 'https://company.atlassian.net/browse/ORCA-123',
      jiraIdentifier: 'ORCA-123'
    })
  })

  it('preserves global work-item sources across repo changes', () => {
    expect(shouldPreserveWorkspaceSourceOnRepoChange(linear)).toBe(true)
    expect(
      shouldPreserveWorkspaceSourceOnRepoChange({
        provider: 'jira',
        type: 'issue',
        number: 0,
        title: 'Workspace scoped',
        url: 'https://acme.atlassian.net/browse/FUS-1'
      })
    ).toBe(true)
    // Why: Jira items picked from smart search may arrive without an explicit
    // provider; preservation must still hold via URL/identifier inference.
    expect(
      shouldPreserveWorkspaceSourceOnRepoChange({
        type: 'issue',
        number: 0,
        title: 'Inferred Jira',
        url: 'https://acme.atlassian.net/browse/FUS-1',
        jiraIdentifier: 'FUS-1'
      })
    ).toBe(true)
    expect(
      shouldPreserveWorkspaceSourceOnRepoChange({
        provider: 'github',
        type: 'issue',
        number: 1,
        title: 'Repo scoped',
        url: 'https://github.com/o/r/issues/1'
      })
    ).toBe(false)
    // Why: GitLab is repo-scoped; pin both the explicit MR and the
    // URL-inferred shape clear, since folder-source/project-group paths delegate here.
    expect(
      shouldPreserveWorkspaceSourceOnRepoChange({
        provider: 'gitlab',
        type: 'mr',
        number: 2,
        title: 'Repo scoped MR',
        url: 'https://gitlab.com/o/r/-/merge_requests/2'
      })
    ).toBe(false)
    expect(
      shouldPreserveWorkspaceSourceOnRepoChange({
        type: 'issue',
        number: 3,
        title: 'Inferred GitLab',
        url: 'https://gitlab.example.com/g/p/-/work_items/3'
      })
    ).toBe(false)
    // Why: a null source (branch-only) has nothing to preserve; callers guard on this.
    expect(shouldPreserveWorkspaceSourceOnRepoChange(null)).toBe(false)
  })

  it('gives a contributed item its own selection kind instead of a GitHub issue', () => {
    const contributed = buildPluginWorkspaceSource({
      key: 'AB-41',
      title: 'Ship the detail panel',
      url: 'https://dev.azure.com/contoso/proj/_workitems/edit/41',
      pluginKey: 'nssf.azure-boards',
      sourceId: 'boards'
    })
    expect(contributed).toEqual({
      provider: 'plugin',
      type: 'issue',
      number: 0,
      title: 'AB-41 Ship the detail panel',
      url: 'https://dev.azure.com/contoso/proj/_workitems/edit/41',
      pluginKey: 'nssf.azure-boards',
      sourceId: 'boards'
    })
    // The identity travels with the selection: the composer resolves the
    // contributing plugin's own icon from it.
    expect(buildWorkspaceSourceSelection({ linkedWorkItem: contributed })).toEqual({
      kind: 'plugin',
      label: 'AB-41 Ship the detail panel',
      url: 'https://dev.azure.com/contoso/proj/_workitems/edit/41',
      pluginKey: 'nssf.azure-boards',
      sourceId: 'boards'
    })
    expect(getWorkspaceSourceName(contributed)).toEqual({
      seedName: 'ab-41-ship-the-detail-panel',
      displayName: 'AB-41 Ship the detail panel'
    })
    // A contributed source is account-backed, so the repo picker must not clear it.
    expect(shouldPreserveWorkspaceSourceOnRepoChange(contributed)).toBe(true)
  })

  it('resolves the selection kind by an exhaustive switch, never a default arm', () => {
    // A `default` would compile against a new provider and then render it as
    // whatever arm the fallback names. The switch is the safety net.
    const source = readFileSync(join(__dirname, 'workspace-source.ts'), 'utf8')
    const resolver = source.slice(source.indexOf('function getWorkspaceSourceSelectionKind'))
    expect(resolver.slice(0, resolver.indexOf('\n}'))).not.toContain('default:')
  })

  it('shares provider inference, selection labels, and auto-name gates', () => {
    const legacyGitLab = {
      type: 'issue' as const,
      number: 7,
      title: 'Self hosted',
      url: 'https://gitlab.example.com/g/p/-/work_items/7'
    }
    expect(getWorkspaceSourceProvider(legacyGitLab)).toBe('gitlab')
    expect(buildWorkspaceSourceSelection({ linkedWorkItem: legacyGitLab })).toMatchObject({
      kind: 'gitlab-issue',
      label: '#7 Self hosted'
    })
    expect(shouldApplyWorkspaceSourceAutoName({ currentName: '#42', lastAutoName: 'old' })).toBe(
      true
    )
    expect(
      shouldApplyWorkspaceSourceAutoName({ currentName: 'my workspace', lastAutoName: 'old' })
    ).toBe(false)
  })
})
