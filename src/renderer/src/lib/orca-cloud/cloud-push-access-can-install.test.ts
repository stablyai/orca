// REPO-CAN-INSTALL (#645): the control plane's `canInstall` decides the push notice's button when it
// knows; the person's gh read is asked only when it can't tell (null) or the Worker is older (absent).
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const state: { answer: unknown; rights: ReturnType<typeof vi.fn> } = {
    answer: null,
    rights: vi.fn(async () => ({ ok: true, value: { admin: true, ownerType: 'Organization' } }))
  }
  return state
})

vi.mock('./use-orca-cloud-repo-access', () => ({
  fetchOrcaCloudRepoAccess: async () => mocks.answer
}))
vi.mock('./orca-cloud-workspace-store', () => ({
  cloudWorkspaceApi: () => ({ gitHubInstallRights: mocks.rights })
}))

import { fetchCloudPushAccess } from './cloud-push-access'

const REPO = 'https://github.com/octocat/Hello-World'

beforeEach(() => {
  mocks.rights.mockClear()
})

describe('the push notice reads canInstall first', () => {
  it('true: Install, without asking gh', async () => {
    mocks.answer = { access: 'public', owner: 'octocat', repo: REPO, canInstall: true }
    expect(await fetchCloudPushAccess(REPO)).toBe('install')
    expect(mocks.rights).not.toHaveBeenCalled()
  })

  it('false: no Install, even though gh would have said admin', async () => {
    mocks.answer = { access: 'missing', owner: 'octocat', repo: REPO, canInstall: false }
    expect(await fetchCloudPushAccess(REPO)).toBe('cantInstall')
    expect(mocks.rights).not.toHaveBeenCalled()
  })

  it('null (no connected GitHub) or absent (older Worker): falls back to gh', async () => {
    mocks.answer = { access: 'public', owner: 'octocat', repo: REPO, canInstall: null }
    expect(await fetchCloudPushAccess(REPO)).toBe('install')
    mocks.answer = { access: 'public', owner: 'octocat', repo: REPO }
    expect(await fetchCloudPushAccess(REPO)).toBe('install')
    expect(mocks.rights).toHaveBeenCalledTimes(2)
  })
})
