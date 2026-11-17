// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import { parseGitHubIssueOrPRLink } from '../../../../../../shared/github/repositories/links'
import { clearRepoSlugCacheValues } from '@/lib/workspace/catalog/repo-slug-cache'

const mocks = vi.hoisted(() => ({ endpoint: vi.fn() }))
vi.mock('@/store/index', async () => {
  const { create } = await import('zustand')
  return { useAppStore: create<{ repos: Repo[] }>(() => ({ repos: [] })) }
})
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: vi.fn() }))
vi.mock('@/i18n/use-translate', () => ({
  useTranslate: () => (_key: string, fallback: string) => fallback,
  useIntlLocale: () => 'en-US'
}))
vi.mock('@/lib/workspace/catalog/repo-slug-index', async () => {
  const { rememberRepoSlug, repoSlugCacheKey } =
    await import('@/lib/workspace/catalog/repo-slug-cache')
  return {
    resolveRepoSlug: async (repo: Repo) => {
      const key = repoSlugCacheKey(repo)
      if (key) {
        rememberRepoSlug(key, 'acme/router')
      }
      return 'acme/router'
    }
  }
})

const { useAppStore } = await import('@/store/index')
const { NativeChatGitHubPeekBody } = await import('./NativeChatGitHubLinkPeek')

const alice: Repo = {
  id: 'router',
  path: '/router',
  displayName: 'Router',
  badgeColor: '',
  addedAt: 0,
  ghAccount: { host: 'github.com', user: 'alice' }
}
const bob: Repo = { ...alice, ghAccount: { host: 'github.com', user: 'bob' } }

type Request = { user: string | undefined; answer: (title: string) => void }
let requests: Request[] = []

beforeEach(() => {
  clearRepoSlugCacheValues()
  requests = []
  useAppStore.setState({ repos: [alice] })
  mocks.endpoint.mockReset()
  mocks.endpoint.mockImplementation(
    ({ number }: { number: number }) =>
      new Promise((resolve) => {
        requests.push({
          user: useAppStore.getState().repos[0]?.ghAccount?.user,
          answer: (title) =>
            resolve({
              type: 'pr',
              number,
              title,
              state: 'open',
              url: `https://github.com/acme/private/pull/${number}`
            })
        })
      })
  )
  vi.stubGlobal('api', { gh: { workItemByOwnerRepo: mocks.endpoint } })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const settle = () =>
  act(async () => {
    for (let i = 0; i < 10; i += 1) {
      await Promise.resolve()
    }
  })

it.each([
  { number: 901, source: 'routed', commits: 'separate', requested: ['alice', 'bob', 'alice'] },
  { number: 902, source: 'routed', commits: 'one', requested: ['alice', 'alice'] },
  { number: 903, source: 'repo', commits: 'separate', requested: ['alice', 'bob', 'alice'] },
  { number: 904, source: 'repo', commits: 'one', requested: ['alice', 'alice'] }
] as const)(
  '$source card shows the current account after A -> B -> A in $commits commit(s) while A is pending',
  async ({ number, source, commits, requested }) => {
    const link = parseGitHubIssueOrPRLink(`https://github.com/acme/private/pull/${number}`)!
    function Card() {
      const repo = useAppStore((state) => state.repos[0])
      return (
        <NativeChatGitHubPeekBody
          source={
            source === 'routed' ? { kind: 'routed', authorityKey: 'local' } : { kind: 'repo', repo }
          }
          link={link}
        />
      )
    }
    render(<Card />)
    await settle()
    if (commits === 'separate') {
      act(() => useAppStore.setState({ repos: [bob] }))
      await settle()
      act(() => useAppStore.setState({ repos: [alice] }))
    } else {
      act(() => {
        useAppStore.setState({ repos: [bob] })
        useAppStore.setState({ repos: [alice] })
      })
    }
    await settle()

    // The first Alice request was retired by the switch, so its late answer must not paint.
    await act(async () => requests[0].answer('retired answer'))
    await settle()
    for (const request of requests.slice(1)) {
      await act(async () => request.answer(`${request.user} answer`))
    }
    await settle()

    expect(requests.map((request) => request.user)).toEqual(requested)
    expect(screen.getByText('alice answer')).toBeTruthy()
    expect(screen.queryByText('retired answer')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  }
)
