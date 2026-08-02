// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { AppState } from '@/store/types'
import type { AiVaultSessionResumeTargetState } from './ai-vault-session-resume'
import {
  buildAiVaultHostScopeOptions,
  buildRuntimeAiVaultHostScopeOptions,
  useAiVaultExecutionHostScope
} from './ai-vault-host-scope'
import type { ExecutionHostScope } from '../../../../shared/execution-host'

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
  executionHostId?: string | null
  hostId?: string | null
}): AiVaultSessionResumeTargetState {
  return {
    folderWorkspaces: [],
    projectGroups: [],
    repos: [
      {
        id: args.repoId,
        connectionId: null,
        executionHostId: args.executionHostId ?? 'local'
      }
    ],
    worktreesByRepo: {
      [args.repoId]: [
        {
          id: args.worktreeId,
          repoId: args.repoId,
          hostId: args.hostId ?? null
        }
      ]
    }
  } as unknown as Pick<AppState, 'folderWorkspaces' | 'projectGroups' | 'repos' | 'worktreesByRepo'>
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
  it('defaults SSH worktrees to their SSH execution host', async () => {
    await renderHook({
      activeWorktreeId: 'repo-1::/remote/repo',
      resumeTargetState: stateForWorktree({
        worktreeId: 'repo-1::/remote/repo',
        repoId: 'repo-1',
        hostId: 'ssh:dev-box'
      })
    })

    expect(latest?.executionHostScope).toBe('ssh:dev-box')
    expect(latest?.activeExecutionHostScope).toBe('ssh:dev-box')
  })

  it('defaults local worktrees to local history', async () => {
    await renderHook({
      activeWorktreeId: 'repo-1::/local/repo',
      resumeTargetState: stateForWorktree({
        worktreeId: 'repo-1::/local/repo',
        repoId: 'repo-1'
      })
    })

    expect(latest?.executionHostScope).toBe('local')
    expect(latest?.activeExecutionHostScope).toBeNull()
  })

  it('defaults runtime worktrees to their runtime execution host', async () => {
    await renderHook({
      activeWorktreeId: 'repo-1::/runtime/repo',
      resumeTargetState: stateForWorktree({
        worktreeId: 'repo-1::/runtime/repo',
        repoId: 'repo-1',
        executionHostId: 'runtime:remote-server'
      }),
      availableExecutionHostScopes: ['runtime:remote-server'] as const
    })

    expect(latest?.executionHostScope).toBe('runtime:remote-server')
    expect(latest?.activeExecutionHostScope).toBe('runtime:remote-server')
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

describe('buildAiVaultHostScopeOptions', () => {
  it('adds saved runtime hosts between active SSH and all hosts', () => {
    const runtimeHostOptions = buildRuntimeAiVaultHostScopeOptions([
      { id: 'remote-server', name: 'VPS Orca Server' }
    ])

    expect(
      buildAiVaultHostScopeOptions({
        activeExecutionHostScope: 'ssh:dev-box',
        runtimeHostOptions
      })
    ).toEqual([
      { id: 'local', label: expect.any(String) },
      { id: 'ssh:dev-box', label: 'dev-box' },
      { id: 'runtime:remote-server', label: 'VPS Orca Server' },
      { id: 'all', label: 'All hosts' }
    ])
  })

  it('keeps a runtime active host visible even before the saved environment list hydrates', () => {
    expect(
      buildAiVaultHostScopeOptions({
        activeExecutionHostScope: 'runtime:remote-server',
        runtimeHostOptions: []
      })
    ).toEqual([
      { id: 'local', label: expect.any(String) },
      { id: 'runtime:remote-server', label: 'remote-server' },
      { id: 'all', label: 'All hosts' }
    ])
  })
})
