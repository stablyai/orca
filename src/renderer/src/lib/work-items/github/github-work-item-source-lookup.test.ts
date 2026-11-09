import type * as RuntimeRpcCallModule from '@/runtime/rpc/calls/runtime-rpc-call'
import type * as RuntimeCapabilityProofModule from '@/runtime/rpc/compatibility/runtime-capability-proof'

import { GITHUB_COMPLETE_PR_CHECK_OBSERVATION_CAPABILITY as complete } from '../../../../../shared/source-control/runtime/source-control-runtime-capabilities'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'

import {
  lookupGitHubWorkItemDetailsForSource,
  lookupGitHubWorkItemByOwnerRepoForSource
} from './github-work-item-source-lookup'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import {
  clearRuntimeEnvironmentConnectionGenerations,
  setRuntimeEnvironmentConnectionGenerationForTests
} from '@/store/slices/runtime-status/runtime-status-connection-generation'

import type { TaskSourceContext } from '../../../../../shared/work-items/task-source-context'
import { useAppStore } from '@/store/index'

import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/hosts/capabilities/local-runtime-capabilities'

import { isCompletePRCheckOwner } from '../../../../../shared/github/complete-pr-check-owner'
import { lookupCmdJGitHubUrlWorkItem } from '../../cmd-j-github-url-lookup'

vi.mock('@/store/index', async () => {
  const { create } = await import('zustand')
  return { useAppStore: create(() => ({ repos: [], runtimeStatusByEnvironmentId: new Map() })) }
})

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async () => {
  const actual = await vi.importActual<typeof RuntimeRpcCallModule>(
    '@/runtime/rpc/calls/runtime-rpc-call'
  )
  return {
    ...actual,
    callRuntimeRpc: vi.fn()
  }
})
vi.mock('@/runtime/rpc/compatibility/runtime-capability-proof', async () => {
  const actual = await vi.importActual<typeof RuntimeCapabilityProofModule>(
    '@/runtime/rpc/compatibility/runtime-capability-proof'
  )
  return {
    ...actual,
    runtimeEnvironmentSupportsCapability: vi.fn().mockResolvedValue(false)
  }
})

const runtimeSourceContext: TaskSourceContext = {
  kind: 'task-source',
  provider: 'github',
  projectId: 'project-1',
  hostId: 'runtime:env-1',
  repoId: 'runtime-repo'
}

describe('GitHub source lookup routing', () => {
  beforeEach(() => {
    replaceRuntimeEnvironmentRevisions([{ id: 'env-1', createdAt: 100, pairingRevision: 701 }])
    setRuntimeEnvironmentConnectionGenerationForTests('env-1', 4)
    vi.mocked(callRuntimeRpc).mockReset()
    useAppStore.setState({ runtimeStatusByEnvironmentId: new Map() })
    setLocalRuntimeCapabilitiesForTests(null)
    vi.stubGlobal('window', {
      api: {
        gh: {
          workItemDetails: vi.fn(),
          workItem: vi.fn(),
          workItemByOwnerRepo: vi.fn().mockResolvedValue(null)
        }
      }
    })
  })

  afterEach(() => {
    replaceRuntimeEnvironmentRevisions([])
    clearRuntimeEnvironmentConnectionGenerations()
    vi.unstubAllGlobals()
    setLocalRuntimeCapabilitiesForTests(null)
  })

  it.each(['local', 'ssh:build-box'] as const)(
    'forwards %s source identity to exact repository IPC',
    async (hostId) => {
      const sourceContext: TaskSourceContext = { ...runtimeSourceContext, hostId, repoId: 'repo' }
      await lookupGitHubWorkItemByOwnerRepoForSource({
        repoPath: '/repo',
        repoId: 'repo',
        sourceContext,
        owner: 'acme',
        repo: 'orca',
        host: 'github.com',
        number: 42,
        type: 'pr'
      })
      expect(window.api.gh.workItemByOwnerRepo).toHaveBeenCalledWith({
        repoPath: '/repo',
        repoId: 'repo',
        sourceContext,
        owner: 'acme',
        repo: 'orca',
        host: 'github.com',
        number: 42,
        type: 'pr'
      })
      expect(callRuntimeRpc).not.toHaveBeenCalled()
    }
  )

  it('keeps local GitHub details on Electron IPC with source context', async () => {
    vi.mocked(window.api.gh.workItemDetails).mockResolvedValue(null)
    const sourceContext: TaskSourceContext = {
      ...runtimeSourceContext,
      hostId: 'local',
      repoId: 'local-repo'
    }

    await expect(
      lookupGitHubWorkItemDetailsForSource({
        repoPath: 'C:\\workspace\\app',
        repoId: 'local-repo',
        sourceContext,
        number: 42,
        type: 'issue'
      })
    ).resolves.toBeNull()

    expect(window.api.gh.workItemDetails).toHaveBeenCalledWith({
      repoPath: 'C:\\workspace\\app',
      repoId: 'local-repo',
      sourceContext,
      number: 42,
      type: 'issue',
      canonical: false
    })
    expect(callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('sends a local issue row repository to the repo-scoped details route', async () => {
    const ownerRepo = { owner: 'fork-owner', repo: 'widgets', host: 'github.com' }
    vi.mocked(window.api.gh.workItemDetails).mockResolvedValue(null)

    await expect(
      lookupGitHubWorkItemDetailsForSource({
        repoPath: '/home/fixture/widgets',
        repoId: 'local-repo',
        number: 12,
        type: 'issue',
        ownerRepo
      })
    ).rejects.toThrow('fork-owner/widgets#12')

    expect(window.api.gh.workItemDetails).toHaveBeenCalledWith(
      expect.objectContaining({ repoPath: '/home/fixture/widgets', ownerRepo })
    )
    expect(callRuntimeRpc).not.toHaveBeenCalled()
  })
})

const foundPR = {
  id: 'pr:42',
  number: 42,
  type: 'pr' as const,
  title: 'Found PR',
  url: 'https://github.com/acme/orca/pull/42',
  labels: [],
  author: null,
  state: 'open' as const,
  updatedAt: '',
  headSha: 'a'.repeat(40),
  prRepo: { owner: 'acme', repo: 'orca', host: 'github.com' },
  checksSummary: {
    state: 'failure' as const,
    total: 1,
    passed: 0,
    failed: 1,
    pending: 0,
    neutral: 0
  }
}

describe('PR metadata and complete checks admission', () => {
  beforeEach(() => {
    replaceRuntimeEnvironmentRevisions([{ id: 'env-1', createdAt: 100, pairingRevision: 701 }])
    setRuntimeEnvironmentConnectionGenerationForTests('env-1', 4)
    useAppStore.setState({ runtimeStatusByEnvironmentId: new Map() })
    vi.mocked(callRuntimeRpc).mockReset()
    vi.stubGlobal('window', { api: { gh: { workItemByOwnerRepo: vi.fn() } } })
  })
  afterEach(() => {
    replaceRuntimeEnvironmentRevisions([])
    clearRuntimeEnvironmentConnectionGenerations()
    setLocalRuntimeCapabilitiesForTests(null)
    vi.unstubAllGlobals()
  })

  it('keeps a pasted Cmd-J PR link when local capability arrives while the lookup is pending', async () => {
    const reply = Promise.withResolvers<typeof foundPR>()
    const started = Promise.withResolvers<void>()
    vi.mocked(window.api.gh.workItemByOwnerRepo).mockImplementation(async () => {
      started.resolve()
      return reply.promise
    })
    const pending = lookupCmdJGitHubUrlWorkItem({
      link: { slug: foundPR.prRepo, number: 42, type: 'pr' },
      repo: { id: 'local', path: '/repo' },
      sourceContext: null
    })
    await started.promise
    setLocalRuntimeCapabilitiesForTests([complete])
    reply.resolve(foundPR)
    const result = await pending
    expect(result).toMatchObject({ title: 'Found PR', number: 42 })
    expect(result && isCompletePRCheckOwner(result)).toBe(false)
  })
})
