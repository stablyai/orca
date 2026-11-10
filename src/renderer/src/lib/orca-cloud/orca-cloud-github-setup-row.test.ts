import { describe, expect, it } from 'vitest'
import { orcaCloudGitHubSetupRow } from './orca-cloud-github-setup-row'
import { orcaCloudGitHubRepoUrl, repoAccessState } from './use-orca-cloud-repo-access'

const identity = (remoteUrl: string) => ({
  gitRemoteIdentity: { canonicalKey: 'k', remoteName: 'origin', remoteUrl }
})

describe('orcaCloudGitHubRepoUrl', () => {
  it('reads the GitHub repository from the remote with no network call (D3)', () => {
    expect(orcaCloudGitHubRepoUrl(identity('git@github.com:acme/web.git'))).toBe(
      'https://github.com/acme/web'
    )
    expect(orcaCloudGitHubRepoUrl(identity('https://github.com/acme/web'))).toBe(
      'https://github.com/acme/web'
    )
    expect(orcaCloudGitHubRepoUrl(identity('git@gitlab.com:acme/web.git'))).toBeNull()
    expect(orcaCloudGitHubRepoUrl({ gitRemoteIdentity: null })).toBeNull()
  })
})

describe('repoAccessState', () => {
  it('maps the control plane answer to the promised states', () => {
    expect(repoAccessState('public')).toBe('ok')
    expect(repoAccessState('granted')).toBe('ok')
    expect(repoAccessState('missing')).toBe('needs-install')
    expect(repoAccessState('requested')).toBe('pending-approval')
    expect(repoAccessState(undefined)).toBe('unknown')
  })
})

describe('orcaCloudGitHubSetupRow', () => {
  const base = { repoName: 'acme/billing', owner: 'acme', loading: false }
  it('D1: needed, with an install action', () => {
    expect(
      orcaCloudGitHubSetupRow({ ...base, state: 'needs-install', access: 'missing' })
    ).toMatchObject({
      step: { id: 'github', state: 'needed', detail: 'Orca Cloud can’t reach acme/billing yet.' },
      label: 'GitHub access',
      status: 'Needed',
      note: 'It clones your code from GitHub. Give access to this repository once.',
      action: { kind: 'install' },
      blocksStart: true
    })
  })
  it('D2: waiting for an owner on GitHub', () => {
    expect(
      orcaCloudGitHubSetupRow({ ...base, state: 'pending-approval', access: 'requested' })
    ).toMatchObject({
      step: {
        state: 'pending',
        detail: 'Waiting for an owner of acme on GitHub to approve Orca Cloud.'
      },
      status: 'Requested',
      note: 'GitHub sent them the request. This workspace starts once they approve, if Orca is open.',
      blocksStart: true
    })
  })
  it('D3: not on GitHub outranks everything and links to the push guide', () => {
    const row = orcaCloudGitHubSetupRow({
      repoName: 'scratch',
      loading: false,
      state: 'not-github'
    })
    expect(row).toMatchObject({
      step: { state: 'failed', detail: 'Orca Cloud starts from a GitHub repository.' },
      label: 'GitHub repository',
      action: { kind: 'push-help', label: 'How to push' },
      blocksStart: true
    })
  })
  it('done rows: public says so, granted names the repository; unknown never blocks', () => {
    expect(orcaCloudGitHubSetupRow({ ...base, state: 'ok', access: 'public' }).step.detail).toBe(
      'acme/billing is public. Nothing to do.'
    )
    expect(orcaCloudGitHubSetupRow({ ...base, state: 'ok', access: 'granted' }).step).toEqual({
      id: 'github',
      state: 'done',
      detail: 'acme/billing'
    })
    expect(orcaCloudGitHubSetupRow({ ...base, state: 'unknown', loading: true })).toMatchObject({
      step: { state: 'active' },
      blocksStart: false
    })
  })
})
