import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import type { PersistedTrustedOrcaHooks } from '../../../shared/types'
import { __resetTrustPromptChainForTests, ensureHooksConfirmed } from './ensure-hooks-confirmed'
import { hashOrcaHookScript } from './orca-hook-trust'

const hooksCheckMock = vi.fn()
const readIssueCommandMock = vi.fn()

;(globalThis as { window: unknown }).window = {
  api: {
    hooks: {
      check: hooksCheckMock,
      readIssueCommand: readIssueCommandMock
    }
  }
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

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('ensureHooksConfirmed', () => {
  beforeEach(() => {
    hooksCheckMock.mockReset()
    readIssueCommandMock.mockReset()
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
    await flush()

    expect(pending).toHaveLength(1)
    expect(pending[0].data.scriptContent).toBe('new script')

    pending[0].resolve('run')
    await expect(promise).resolves.toBe('run')
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

  it('opens a modal with the computed content hash and resolves with the user decision', async () => {
    const { state, pending } = createTestState()
    hooksCheckMock.mockResolvedValue({
      hasHooks: true,
      hooks: { scripts: { setup: 'pnpm install' } },
      mayNeedUpdate: false
    })

    const promise = ensureHooksConfirmed(state, 'repo-1', 'setup')
    await flush()

    expect(pending).toHaveLength(1)
    expect(pending[0].data).toMatchObject({
      repoId: 'repo-1',
      repoName: 'Repo One',
      scriptKind: 'setup',
      scriptContent: 'pnpm install',
      contentHash: await hashOrcaHookScript('pnpm install')
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

    await flush()

    expect(pending).toHaveLength(1)
    expect(pending[0].data.scriptKind).toBe('setup')

    pending[0].resolve('skip')
    await expect(first).resolves.toBe('skip')

    await flush()

    expect(pending).toHaveLength(2)
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
})
