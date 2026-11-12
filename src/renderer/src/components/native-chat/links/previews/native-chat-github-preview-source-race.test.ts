import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../../../shared/repo-types'
import { parseGitHubIssueOrPRLink } from '../../../../../../shared/github/repositories/links'
import { clearRepoSlugCacheValues } from '@/lib/workspace/catalog/repo-slug-cache'

const mocks = await vi.hoisted(async () => {
  const { createStore } = await import('zustand/vanilla')
  return {
    store: createStore<{ repos: Repo[] }>(() => ({ repos: [] })),
    slugGate: Promise.resolve(),
    slugStarted: Promise.withResolvers<void>(),
    endpoint: vi.fn(),
    rpc: vi.fn()
  }
})
vi.mock('@/store/index', () => ({ useAppStore: mocks.store }))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: mocks.rpc }))
vi.mock('@/lib/workspace/catalog/repo-slug-index', async () => {
  const { rememberRepoSlug, repoSlugCacheKey } =
    await import('@/lib/workspace/catalog/repo-slug-cache')
  return {
    resolveRepoSlug: async (repo: Repo) => {
      mocks.slugStarted.resolve()
      await mocks.slugGate
      const key = repoSlugCacheKey(repo)
      const slug = repo.id === 'nested-u' ? 'acme/private' : 'acme/router'
      if (key) {
        rememberRepoSlug(key, slug)
      }
      return slug
    }
  }
})

const { loadRoutedGitHubLinkPreview, readCachedRoutedGitHubLinkPreview } =
  await import('./native-chat-github-link-preview')

const alice: Repo = {
  id: 'router',
  path: '/router',
  displayName: 'Router',
  badgeColor: '',
  addedAt: 0,
  ghAccount: { host: 'github.com', user: 'alice' }
}
const bob: Repo = { ...alice, ghAccount: { host: 'github.com', user: 'bob' } }

beforeEach(() => {
  clearRepoSlugCacheValues()
  mocks.store.setState({ repos: [alice] })
  mocks.slugGate = Promise.resolve()
  mocks.slugStarted = Promise.withResolvers<void>()
  mocks.endpoint.mockReset()
  mocks.rpc.mockReset()
  mocks.endpoint.mockImplementation(async ({ number }: { number: number }) => ({
    type: 'pr',
    number,
    title: `${mocks.store.getState().repos[0].ghAccount?.user} response`,
    url: `https://github.com/acme/private/pull/${number}`
  }))
  vi.stubGlobal('window', { api: { gh: { workItemByOwnerRepo: mocks.endpoint } } })
})
afterEach(() => vi.unstubAllGlobals())

it('discards a lookup whose binding changes while its slug is resolving', async () => {
  const gate = Promise.withResolvers<void>()
  mocks.slugGate = gate.promise
  const link = parseGitHubIssueOrPRLink('https://github.com/acme/private/pull/801')!
  const pending = loadRoutedGitHubLinkPreview('local', link)
  await mocks.slugStarted.promise
  mocks.store.setState({ repos: [bob] })
  gate.resolve()
  await expect(pending).resolves.toBeNull()

  mocks.store.setState({ repos: [alice] })
  expect(readCachedRoutedGitHubLinkPreview('local', link)).toBeNull()
  await expect(loadRoutedGitHubLinkPreview('local', link)).resolves.toMatchObject({
    title: 'alice response'
  })
})

it('does not commit a response if the binding changes during the GitHub request', async () => {
  const gate = Promise.withResolvers<void>()
  const sent = Promise.withResolvers<void>()
  mocks.endpoint.mockImplementationOnce(async ({ number }: { number: number }) => {
    sent.resolve()
    await gate.promise
    return {
      type: 'pr',
      number,
      title: 'bob response',
      url: `https://github.com/acme/private/pull/${number}`
    }
  })
  const link = parseGitHubIssueOrPRLink('https://github.com/acme/private/pull/802')!
  const pending = loadRoutedGitHubLinkPreview('local', link)
  await sent.promise
  mocks.store.setState({ repos: [bob] })
  gate.resolve()
  await expect(pending).resolves.toBeNull()

  mocks.store.setState({ repos: [alice] })
  expect(readCachedRoutedGitHubLinkPreview('local', link)).toBeNull()
  await expect(loadRoutedGitHubLinkPreview('local', link)).resolves.toMatchObject({
    title: 'alice response'
  })
})

it('rejects an in-flight response even if Alice is restored before it settles', async () => {
  const gate = Promise.withResolvers<void>()
  const sent = Promise.withResolvers<void>()
  mocks.endpoint.mockImplementationOnce(async ({ number }: { number: number }) => {
    sent.resolve()
    await gate.promise
    return {
      type: 'pr',
      number,
      title: 'bob response',
      url: `https://github.com/acme/private/pull/${number}`
    }
  })
  const link = parseGitHubIssueOrPRLink('https://github.com/acme/private/pull/803')!
  const pending = loadRoutedGitHubLinkPreview('local', link)
  await sent.promise
  mocks.store.setState({ repos: [bob] })
  mocks.store.setState({ repos: [alice] })
  gate.resolve()
  await expect(pending).resolves.toBeNull()
  expect(readCachedRoutedGitHubLinkPreview('local', link)).toBeNull()
  await expect(loadRoutedGitHubLinkPreview('local', link)).resolves.toMatchObject({
    title: 'alice response'
  })
})

it('keeps endpoint-local, nested T and nested U lookups on their own repo/account', async () => {
  const endpoint: Repo = { ...alice, id: 'endpoint', executionHostId: 'runtime:env' }
  const targetT: Repo = {
    ...alice,
    id: 'nested-t',
    executionHostId: 'runtime:env',
    connectionId: 'T',
    ghAccount: { host: 'github.com', user: 't' }
  }
  const targetU: Repo = {
    ...alice,
    id: 'nested-u',
    executionHostId: 'runtime:env',
    connectionId: 'U',
    ghAccount: { host: 'github.com', user: 'u' }
  }
  mocks.store.setState({ repos: [endpoint, targetT, targetU] })
  mocks.rpc.mockImplementation(async (_target, _method, params, options) => {
    options?.beforeSend?.()
    const repo = mocks.store.getState().repos.find((row) => row.id === params.repo)
    return {
      type: 'pr',
      number: params.number,
      title: `${repo?.ghAccount?.user} response`,
      url: `https://github.com/acme/private/pull/${params.number}`
    }
  })
  const link = parseGitHubIssueOrPRLink('https://github.com/acme/private/pull/804')!
  await expect(loadRoutedGitHubLinkPreview('runtime:env', link)).resolves.toMatchObject({
    title: 'alice response'
  })
  await expect(loadRoutedGitHubLinkPreview('nested:env/T', link)).resolves.toMatchObject({
    title: 't response'
  })
  await expect(loadRoutedGitHubLinkPreview('nested:env/U', link)).resolves.toMatchObject({
    title: 'u response'
  })
})
