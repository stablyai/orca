// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { TEST_REPO, makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import type { AiVaultSessionResumeTargetState } from '../session-actions/ai-vault-session-resume'
import { useAiVaultExecutionHostScope } from './ai-vault-host-scope'
import type { ExecutionHostId, ExecutionHostScope } from '../../../../../../shared/execution-host'

type HostScopeResult = ReturnType<typeof useAiVaultExecutionHostScope>

let root: Root | null = null
let latest: HostScopeResult | null = null

function HookProbe(props: {
  activeWorktreeId: string | null
  resumeTargetState: AiVaultSessionResumeTargetState
  availableExecutionHostScopes?: readonly ExecutionHostScope[]
}): null {
  latest = useAiVaultExecutionHostScope(props)
  return null
}

async function renderHook(props: {
  activeWorktreeId: string | null
  resumeTargetState: AiVaultSessionResumeTargetState
  availableExecutionHostScopes?: readonly ExecutionHostScope[]
}): Promise<void> {
  if (!root) {
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  }
  await act(async () => {
    root?.render(createElement(HookProbe, props))
  })
}

function stateForWorktree(args: {
  worktreeId: string
  repoId: string
  executionHostId?: ExecutionHostId | null
  hostId?: ExecutionHostId | null
}): AiVaultSessionResumeTargetState {
  return {
    folderWorkspaces: [],
    projectGroups: [],
    repos: [
      {
        ...TEST_REPO,
        id: args.repoId,
        connectionId: null,
        executionHostId: args.executionHostId ?? 'local'
      }
    ],
    worktreesByRepo: {
      [args.repoId]: [
        makeWorktree({
          id: args.worktreeId,
          repoId: args.repoId,
          hostId: args.hostId ?? undefined
        })
      ]
    }
  }
}

afterEach(() => {
  if (root) {
    act(() => root?.unmount())
  }
  root = null
  latest = null
  document.body.replaceChildren()
})

describe('useAiVaultExecutionHostScope', () => {
  it('does not claim local history when the active workspace host cannot be resolved (#13713)', async () => {
    await renderHook({
      activeWorktreeId: 'repo-1::/remote/repo',
      resumeTargetState: {
        folderWorkspaces: [],
        projectGroups: [],
        repos: [],
        worktreesByRepo: {}
      }
    })

    expect(latest?.executionHostScope).not.toBe('local')
    expect(latest?.executionHostScope).toBe('all')
  })

  it('preserves manual host scope changes across unrelated rerenders', async () => {
    const props = {
      activeWorktreeId: 'repo-1::/remote/repo',
      resumeTargetState: stateForWorktree({
        worktreeId: 'repo-1::/remote/repo',
        repoId: 'repo-1',
        hostId: 'ssh:dev-box'
      })
    }
    await renderHook(props)

    await act(async () => {
      latest?.onExecutionHostScopeChange('all')
    })
    await renderHook({ ...props, resumeTargetState: { ...props.resumeTargetState } })

    expect(latest?.executionHostScope).toBe('all')
  })

  it('preserves manual runtime host scope choices while they are still available', async () => {
    const props = {
      activeWorktreeId: 'repo-1::/local/repo',
      resumeTargetState: stateForWorktree({
        worktreeId: 'repo-1::/local/repo',
        repoId: 'repo-1'
      }),
      availableExecutionHostScopes: ['runtime:remote-server'] as const
    }
    await renderHook(props)

    await act(async () => {
      latest?.onExecutionHostScopeChange('runtime:remote-server')
    })
    await renderHook({ ...props, resumeTargetState: { ...props.resumeTargetState } })

    expect(latest?.executionHostScope).toBe('runtime:remote-server')
  })
})
