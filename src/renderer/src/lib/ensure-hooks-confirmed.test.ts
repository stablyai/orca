import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import type { PersistedTrustedOrcaHooks } from '../../../shared/types'
import { __resetTrustPromptChainForTests, ensureHooksConfirmed } from './ensure-hooks-confirmed'
import { hashOrcaHookScript } from './orca-hook-trust'
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
    // The dialog uses this flag to tell the user we're re-prompting *because*
    // orca.yaml changed, not because they've never approved this hook.
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

  it('prompts for VM recipes using the recipe lifecycle declarations', async () => {
    const { state, pending } = createTestState()
    hooksCheckMock.mockResolvedValue({
      hasHooks: true,
      hooks: {
        environmentRecipes: [
          {
            id: 'cloud-sandbox',
            name: 'Cloud Sandbox',
            description: 'Starts a per-workspace VM.',
            create: './scripts/start-vm.sh',
            suspend: './scripts/suspend-vm.sh',
            resume: './scripts/resume-vm.sh',
            destroy: './scripts/destroy-vm.sh'
          }
        ]
      },
      mayNeedUpdate: false
    })

    const promise = ensureHooksConfirmed(state, 'repo-1', 'vmRecipe')

    await vi.waitFor(() => expect(pending).toHaveLength(1))
    expect(pending[0].data.scriptKind).toBe('vmRecipe')
    expect(pending[0].data.scriptContent).toContain('# environmentRecipes.cloud-sandbox')
    expect(pending[0].data.scriptContent).toContain('create: ./scripts/start-vm.sh')
    expect(pending[0].data.scriptContent).toContain('suspend: ./scripts/suspend-vm.sh')
    expect(pending[0].data.scriptContent).toContain('resume: ./scripts/resume-vm.sh')
    expect(pending[0].data.scriptContent).toContain('destroy: ./scripts/destroy-vm.sh')

    pending[0].resolve('run')
    await expect(promise).resolves.toBe('run')
  })

  it('returns run without inspecting hooks when the repo is always trusted', async () => {
    const { state, pending } = createTestState()
    state.trustedOrcaHooks['repo-1'] = {
      all: { approvedAt: 1 }
    }
    hooksCheckMock.mockRejectedValue(new Error('boom'))

    const decision = await ensureHooksConfirmed(state, 'repo-1', 'setup')

    expect(decision).toBe('run')
    expect(hooksCheckMock).not.toHaveBeenCalled()
    expect(pending).toHaveLength(0)
  })

  it('returns run without prompting when no script of that kind is configured', async () => {
    const { state, pending } = createTestState()
    hooksCheckMock.mockResolvedValue({
      hasHooks: true,
      hooks: { scripts: {} },
      mayNeedUpdate: false
    })

    const decision = await ensureHooksConfirmed(state, 'repo-1', 'archive')

    expect(decision).toBe('run')
    expect(pending).toHaveLength(0)
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
    expect(hooksCheckMock).toHaveBeenCalledWith({ repoId: 'repo-1' })
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
      params: { repo: 'repo-1' },
      timeoutMs: 15_000
    })
    expect(hooksCheckMock).not.toHaveBeenCalled()
    expect(pending).toHaveLength(0)
  })

  it('does not prompt for orca.yaml when the repo uses local commands only', async () => {
    const { state, pending } = createTestState({
      repos: [
        {
          id: 'repo-1',
          displayName: 'Repo One',
          hookSettings: {
            mode: 'auto',
            commandSourcePolicy: 'local-only',
            scripts: { setup: 'echo local', archive: '' }
          }
        }
      ]
    } as Partial<AppState>)
    hooksCheckMock.mockResolvedValue({
      hasHooks: true,
      hooks: { scripts: { setup: 'echo shared' } },
      mayNeedUpdate: false
    })

    const decision = await ensureHooksConfirmed(state, 'repo-1', 'setup')

    expect(decision).toBe('run')
    expect(hooksCheckMock).not.toHaveBeenCalled()
    expect(pending).toHaveLength(0)
  })

  it('does not prompt for orca.yaml when local commands are the implicit default', async () => {
    const { state, pending } = createTestState({
      repos: [
        {
          id: 'repo-1',
          displayName: 'Repo One',
          hookSettings: {
            mode: 'auto',
            scripts: { setup: 'echo local', archive: '' }
          }
        }
      ]
    } as Partial<AppState>)
    hooksCheckMock.mockResolvedValue({
      hasHooks: true,
      hooks: { scripts: { setup: 'echo shared' } },
      mayNeedUpdate: false
    })

    const decision = await ensureHooksConfirmed(state, 'repo-1', 'setup')

    expect(decision).toBe('run')
    expect(hooksCheckMock).not.toHaveBeenCalled()
    expect(pending).toHaveLength(0)
  })

  it('returns run without prompting when issueCommand source is local (user-owned)', async () => {
    const { state, pending } = createTestState()
    readIssueCommandMock.mockResolvedValue({
      source: 'local',
      sharedContent: null,
      localContent: 'user content',
      effectiveContent: 'user content',
      localFilePath: ''
    })

    const decision = await ensureHooksConfirmed(state, 'repo-1', 'issueCommand')

    expect(decision).toBe('run')
    expect(pending).toHaveLength(0)
  })

  it('still honors local issueCommand overrides when shared inspection reports an error', async () => {
    const { state, pending } = createTestState()
    readIssueCommandMock.mockResolvedValue({
      status: 'error',
      source: 'local',
      sharedContent: null,
      localContent: 'user content',
      effectiveContent: 'user content',
      localFilePath: ''
    })

    const decision = await ensureHooksConfirmed(state, 'repo-1', 'issueCommand')

    expect(decision).toBe('run')
    expect(pending).toHaveLength(0)
  })

  it('forwards the explicit host to issueCommand inspection when repo ids collide', async () => {
    const { state } = createTestState({
      repos: [
        { id: 'repo-1', displayName: 'Local Row' },
        { id: 'repo-1', displayName: 'SSH Row', connectionId: 'server' }
      ]
    } as unknown as Partial<AppState>)
    readIssueCommandMock.mockResolvedValue({
      source: 'local',
      sharedContent: null,
      localContent: 'user content',
      effectiveContent: 'user content',
      localFilePath: ''
    })

    await ensureHooksConfirmed(state, 'repo-1', 'issueCommand', 'ssh:server')

    expect(readIssueCommandMock).toHaveBeenCalledWith({ repoId: 'repo-1', hostId: 'ssh:server' })
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

  it('opens a modal with the computed content hash and resolves with the user decision', async () => {
    const { state, pending } = createTestState()
    hooksCheckMock.mockResolvedValue({
      hasHooks: true,
      hooks: { scripts: { setup: 'pnpm install' } },
      mayNeedUpdate: false
    })

    const promise = ensureHooksConfirmed(state, 'repo-1', 'setup')

    await vi.waitFor(() => expect(pending).toHaveLength(1))
    expect(pending[0].data).toMatchObject({
      repoId: 'repo-1',
      repoName: 'Repo One',
      scriptKind: 'setup',
      scriptContent: 'pnpm install',
      contentHash: await hashOrcaHookScript('pnpm install'),
      previouslyApproved: false
    })

    pending[0].resolve('run')
    await expect(promise).resolves.toBe('run')
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
})
