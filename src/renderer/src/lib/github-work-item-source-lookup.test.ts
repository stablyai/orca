import { beforeEach, describe, expect, it, vi } from 'vitest'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type * as RuntimeRpcClient from '@/runtime/runtime-rpc-client'
import { lookupGitHubWorkItemDetailsForSource } from './github-work-item-source-lookup'
import type { TaskSourceContext } from '../../../shared/task-source-context'

vi.mock('@/runtime/runtime-rpc-client', async () => {
  const actual = await vi.importActual<typeof RuntimeRpcClient>('@/runtime/runtime-rpc-client')
  return {
    ...actual,
    callRuntimeRpc: vi.fn()
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
    vi.mocked(callRuntimeRpc).mockReset()
    vi.stubGlobal('window', {
      api: {
        gh: {
          workItemDetails: vi.fn()
        }
      }
    })
  })

  it('routes runtime-owned GitHub details through runtime RPC', async () => {
    vi.mocked(callRuntimeRpc).mockResolvedValue(null)

    await expect(
      lookupGitHubWorkItemDetailsForSource({
        repoPath: '/home/runtime/app',
        repoId: 'renderer-repo',
        sourceContext: runtimeSourceContext,
        number: 42,
        type: 'issue'
      })
    ).resolves.toBeNull()

    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'github.workItemDetails',
      { repo: 'runtime-repo', number: 42, type: 'issue' },
      { timeoutMs: 30_000 }
    )
    expect(window.api.gh.workItemDetails).not.toHaveBeenCalled()
  })

  // Regression for #6429: a runtime-sourced details lookup must never reach the
  // local Electron IPC, which rejects unregistered remote repos with
  // "Access denied: unknown repository path". On main this routed through
  // window.api.gh.workItemDetails and surfaced that error.
  it('does not invoke the local IPC (which throws access-denied) for runtime sources', async () => {
    vi.mocked(callRuntimeRpc).mockResolvedValue(null)
    vi.mocked(window.api.gh.workItemDetails).mockRejectedValue(
      new Error('Access denied: unknown repository path')
    )

    await expect(
      lookupGitHubWorkItemDetailsForSource({
        repoPath: '/home/runtime/app',
        repoId: 'renderer-repo',
        sourceContext: runtimeSourceContext,
        number: 42,
        type: 'issue'
      })
    ).resolves.toBeNull()

    expect(window.api.gh.workItemDetails).not.toHaveBeenCalled()
  })

  it('uses the renderer repo id for runtime details when the source has no repo id', async () => {
    vi.mocked(callRuntimeRpc).mockResolvedValue(null)

    await lookupGitHubWorkItemDetailsForSource({
      repoPath: '/home/runtime/app',
      repoId: 'renderer-repo',
      sourceContext: { ...runtimeSourceContext, repoId: null },
      number: 42,
      type: 'pr'
    })

    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'github.workItemDetails',
      { repo: 'renderer-repo', number: 42, type: 'pr' },
      { timeoutMs: 30_000 }
    )
  })

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
      type: 'issue'
    })
    expect(callRuntimeRpc).not.toHaveBeenCalled()
  })
})
