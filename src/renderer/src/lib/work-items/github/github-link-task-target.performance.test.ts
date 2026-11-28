import { beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import { seedStore } from '@/store/testing/app-store-test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { buildHttpLinkActions } from '@/lib/browser/navigation/http-link-destinations'
import type { Repo } from '../../../../../shared/repository/repo-types'

// Guards #46197: the "Open PR/issue in Orca" row is decided from the store alone, with no repo-slug
// probe or lookup on menu open; main decides on click.
vi.mock('@/store/index', async () => {
  const { createTestStore } = await import('@/store/testing/app-store-test-fixture')
  return { useAppStore: createTestStore() }
})
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: vi.fn() }))

const ipcCalls: string[] = []
const api = new Proxy(
  {},
  {
    get: (_, namespace: string) =>
      new Proxy(
        {},
        { get: (__, method: string) => () => void ipcCalls.push(`${namespace}.${method}`) }
      )
  }
)

const rows: Repo[] = [
  { id: 'local', path: '/local', displayName: 'l', badgeColor: '#000', addedAt: 0, kind: 'git' },
  {
    id: 'remote',
    path: '/srv',
    displayName: 'r',
    badgeColor: '#000',
    addedAt: 0,
    kind: 'git',
    executionHostId: 'runtime:builder'
  },
  {
    id: 'ssh',
    path: '/home/x',
    displayName: 's',
    badgeColor: '#000',
    addedAt: 0,
    kind: 'git',
    connectionId: 'T',
    ghAccount: { host: 'ghe.acme.io', user: 'me' }
  }
]
const worktrees = [
  makeWorktree({ id: 'local::/local', repoId: 'local', path: '/local' }),
  makeWorktree({ id: 'remote::/srv', repoId: 'remote', path: '/srv', hostId: 'runtime:builder' }),
  makeWorktree({ id: 'ssh::/home/x', repoId: 'ssh', path: '/home/x', hostId: 'ssh:T' })
]

beforeEach(() => {
  ipcCalls.length = 0
  Object.assign(globalThis, { window: { api } })
  seedStore(useAppStore, {
    repos: rows,
    worktreesByRepo: Object.fromEntries(worktrees.map((entry) => [entry.repoId, [entry]]))
  })
})

it('building link menus for PR and issue links on local, runtime and SSH workspaces makes no IPC or runtime call', () => {
  const urls = [
    'https://github.com/acme/web/pull/21/files',
    'https://github.com/vercel/next.js/issues/7',
    'https://ghe.acme.io/infra/api/pull/4'
  ]
  let offered = 0
  for (let open = 0; open < 10; open++) {
    for (const entry of worktrees) {
      for (const url of urls) {
        const actions = buildHttpLinkActions({ primary: 'system' }, () => {}, {
          worktreeId: entry.id,
          url
        })
        offered += actions.secondaryActions?.some((row) => row.icon === 'open-in-orca') ? 1 : 0
      }
    }
  }

  expect(offered).toBe(70)
  expect(ipcCalls).toEqual([])
  expect(callRuntimeRpc).not.toHaveBeenCalled()
})
