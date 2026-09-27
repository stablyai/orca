// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { AppState } from '@/store/types'
import type { AiVaultSessionResumeTargetState } from './ai-vault-session-resume'
import {
  buildAiVaultHostScopeOptions,
  buildRuntimeAiVaultHostScopeOptions,
  buildSshAiVaultHostScopeOptions,
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

  it('does not claim local history when the active workspace host cannot be resolved (#13713)', async () => {
    // The worktree and its repo are absent from the client store — `unverifiable`, not local.
    await renderHook({
      activeWorktreeId: 'repo-1::/remote/repo',
      resumeTargetState: {
        folderWorkspaces: [],
        projectGroups: [],
        repos: [],
        worktreesByRepo: {}
      } as unknown as AiVaultSessionResumeTargetState
    })

    expect(latest?.executionHostScope).not.toBe('local')
    expect(latest?.executionHostScope).toBe('all')
  })

  it('keeps local history when no workspace is selected at all', async () => {
    await renderHook({
      activeWorktreeId: null,
      resumeTargetState: {
        folderWorkspaces: [],
        projectGroups: [],
        repos: [],
        worktreesByRepo: {}
      } as unknown as AiVaultSessionResumeTargetState
    })

    expect(latest?.executionHostScope).toBe('local')
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

  it('names SSH hosts by their target label and lists every connected one', () => {
    const sshHostOptions = buildSshAiVaultHostScopeOptions({
      sshTargetLabels: new Map([
        ['ssh-runner', 'runner-box'],
        ['ssh-2', 'build-box'],
        ['ssh-3', 'offline-box']
      ]),
      sshConnectionStates: new Map([
        ['ssh-runner', { status: 'connected' as const }],
        ['ssh-2', { status: 'connected' as const }],
        ['ssh-3', { status: 'disconnected' as const }]
      ])
    })
    expect(sshHostOptions).toEqual([
      { id: 'ssh:ssh-2', label: 'build-box' },
      { id: 'ssh:ssh-runner', label: 'runner-box' }
    ])

    expect(
      buildAiVaultHostScopeOptions({
        activeExecutionHostScope: 'ssh:ssh-runner',
        runtimeHostOptions: [],
        sshHostOptions
      })
    ).toEqual([
      { id: 'local', label: expect.any(String) },
      { id: 'ssh:ssh-runner', label: 'runner-box' },
      { id: 'ssh:ssh-2', label: 'build-box' },
      { id: 'all', label: 'All hosts' }
    ])
  })

  it('keeps the active SSH host named while it is disconnected', () => {
    expect(
      buildAiVaultHostScopeOptions({
        activeExecutionHostScope: 'ssh:ssh-1',
        runtimeHostOptions: [],
        sshHostOptions: [],
        sshTargetLabels: new Map([['ssh-1', 'build-box']])
      })
    ).toContainEqual({ id: 'ssh:ssh-1', label: 'build-box' })
  })

  it('keeps naming the active SSH host after its target was removed', () => {
    expect(
      buildAiVaultHostScopeOptions({
        activeExecutionHostScope: 'ssh:ssh-gone',
        runtimeHostOptions: [],
        sshHostOptions: [],
        sshTargetLabels: new Map(),
        removedSshTargetLabels: new Map([['ssh-gone', 'retired-box']])
      })
    ).toContainEqual({ id: 'ssh:ssh-gone', label: 'retired-box' })
  })

  it('leaves out SSH targets owned by a paired Orca server', () => {
    expect(
      buildSshAiVaultHostScopeOptions({
        sshTargetLabels: new Map([
          ['ssh-2', 'build-box'],
          ['runtime-ssh-env-1', 'server session']
        ]),
        sshConnectionStates: new Map([
          ['ssh-2', { status: 'connected' as const }],
          ['runtime-ssh-env-1', { status: 'connected' as const }]
        ])
      })
    ).toEqual([{ id: 'ssh:ssh-2', label: 'build-box' }])
  })
})
