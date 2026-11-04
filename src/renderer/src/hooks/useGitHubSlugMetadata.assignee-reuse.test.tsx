// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitHubAssignableUser } from '../../../shared/github/pull-request-types'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { clearGitHubSlugMetadataCache, useRepoAssigneesBySlug } from './useGitHubSlugMetadata'
import type { MetadataListState } from './useMetadataListRequest'

vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: vi.fn() }))

const listUsers = vi.fn()
const baseUser = { login: 'member', name: 'Member Name', avatarUrl: 'https://example.test/a' }
const results = new Map<string, MetadataListState<GitHubAssignableUser>>()
let root: Root

function Probe({
  id = 'row',
  seeds,
  repo = 'orca',
  host,
  target
}: {
  id?: string
  seeds?: string[]
  repo?: string
  host?: string
  target?: RuntimeClientTarget
}): null {
  results.set(id, useRepoAssigneesBySlug('stablyai', repo, seeds, target, host))
  return null
}

async function render(element: React.ReactNode): Promise<void> {
  await act(async () => {
    root.render(element)
  })
}

function logins(id = 'row'): string[] | undefined {
  return results.get(id)?.data.map((user) => user.login)
}

describe('repository assignee reuse across row seeds', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    clearGitHubSlugMetadataCache()
    listUsers
      .mockReset()
      .mockImplementation(async ({ seedLogins = [] }: { seedLogins?: string[] }) => {
        const extras = [...new Set(seedLogins)].filter((login) => login !== baseUser.login)
        return {
          ok: true,
          users: [baseUser, ...extras.map((login) => ({ login, name: null, avatarUrl: '' }))]
        }
      })
    vi.mocked(callRuntimeRpc)
      .mockReset()
      .mockResolvedValue({ ok: true, users: [baseUser] })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { gh: { listAssignableUsersBySlug: listUsers } }
    })
    results.clear()
    const container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    document.body.replaceChildren()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('loads one base list for concurrent rows without sharing their extra users', async () => {
    await render(
      <>
        <Probe id="a" seeds={['zeta', 'member', 'alpha', 'alpha']} />
        <Probe id="b" seeds={['beta']} />
      </>
    )

    expect(listUsers).toHaveBeenCalledExactlyOnceWith({
      owner: 'stablyai',
      repo: 'orca',
      host: 'github.com'
    })
    expect(logins('a')).toEqual(['member', 'alpha', 'zeta'])
    expect(logins('b')).toEqual(['member', 'beta'])
    expect(results.get('a')?.data[0]).toEqual(baseUser)
    expect(results.get('a')?.data[1]).toEqual({ login: 'alpha', name: null, avatarUrl: '' })
  })

  it('updates seeds in place without a fetch or loading transition', async () => {
    await render(<Probe seeds={['first']} />)
    await render(<Probe seeds={['second']} />)

    expect(logins()).toEqual(['member', 'second'])
    expect(results.get('row')).toMatchObject({ loading: false, error: null })
    expect(listUsers).toHaveBeenCalledTimes(1)
  })

  it('adds seeds to a successful empty list but not to loading or failed results', async () => {
    let finish: (value: { ok: boolean; users: GitHubAssignableUser[] }) => void = () => {}
    listUsers.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)))
    await render(<Probe seeds={['existing']} />)
    expect(results.get('row')).toMatchObject({ data: [], loading: true, error: null })
    await act(async () => finish({ ok: true, users: [] }))
    expect(logins()).toEqual(['existing'])

    listUsers.mockResolvedValueOnce({ ok: false, error: { message: 'Forbidden' } })
    await render(<Probe repo="other" seeds={['unavailable']} />)
    expect(results.get('row')).toMatchObject({ data: [], loading: false, error: 'Forbidden' })
  })

  it('retains seed projection after expiry and fetches fresh metadata for a new reader', async () => {
    const now = Date.now()
    const time = vi.spyOn(Date, 'now').mockReturnValue(now)
    await render(<Probe seeds={['existing']} />)
    time.mockReturnValue(now + 300_001)
    await render(<Probe seeds={['updated']} />)
    expect(logins()).toEqual(['member', 'updated'])
    expect(listUsers).toHaveBeenCalledTimes(1)

    await render(<Probe key="new-reader" seeds={['fresh']} />)
    expect(logins()).toEqual(['member', 'fresh'])
    expect(listUsers).toHaveBeenCalledTimes(2)
  })

  it('isolates repository, host and remote runtime scopes and honors cache clearing', async () => {
    await render(<Probe />)
    await render(<Probe repo="other" />)
    await render(<Probe host="ghe.example.test" />)
    await render(<Probe target={{ kind: 'environment', environmentId: 'remote-a' }} />)
    await render(<Probe target={{ kind: 'environment', environmentId: 'remote-b' }} />)

    expect(listUsers).toHaveBeenCalledTimes(3)
    expect(listUsers).toHaveBeenLastCalledWith({
      owner: 'stablyai',
      repo: 'orca',
      host: 'ghe.example.test'
    })
    expect(callRuntimeRpc).toHaveBeenCalledTimes(2)
    expect(callRuntimeRpc).toHaveBeenLastCalledWith(
      { kind: 'environment', environmentId: 'remote-b' },
      'github.project.listAssignableUsersBySlug',
      { owner: 'stablyai', repo: 'orca', host: 'github.com' },
      { timeoutMs: 30_000 }
    )
    clearGitHubSlugMetadataCache()
    await render(<Probe key="after-auth-change" />)
    expect(listUsers).toHaveBeenCalledTimes(4)
  })
})
