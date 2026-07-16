import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalQuickCommand } from '../../../shared/types'
import { __resetTrustPromptChainForTests } from './ensure-hooks-confirmed'
import { hashOrcaHookScript } from './orca-hook-trust'
import { ensureProjectQuickCommandTrusted } from './project-quick-command-trust'
import { useAppStore } from '@/store'

const checkRuntimeHooksMock = vi.fn()
vi.mock('@/runtime/runtime-hooks-client', () => ({
  checkRuntimeHooks: (...args: unknown[]) => checkRuntimeHooksMock(...args),
  readRuntimeIssueCommand: vi.fn()
}))

// Why: the trust helper reads and writes the real app store singleton, so give
// it a minimal getState/setState stub instead of the full slice graph.
const storeStub = vi.hoisted(() => {
  let state: Record<string, unknown> = {}
  return {
    useAppStore: {
      getState: () => state,
      setState: (
        partial:
          | Record<string, unknown>
          | ((s: Record<string, unknown>) => Record<string, unknown>),
        replace?: boolean
      ) => {
        const next = typeof partial === 'function' ? partial(state) : partial
        state = replace ? { ...next } : { ...state, ...next }
      }
    }
  }
})
vi.mock('@/store', () => ({ useAppStore: storeStub.useAppStore }))

type PendingPrompt = {
  data: Record<string, unknown>
  resolve: (decision: 'run' | 'skip') => void
}

let pending: PendingPrompt[]

function seedStore(overrides?: Record<string, unknown>): void {
  useAppStore.setState(
    {
      trustedOrcaHooks: {},
      repos: [{ id: 'repo-1', displayName: 'Repo One' }],
      settings: null,
      projectQuickCommandsByRepo: {},
      openModal: (_modal: string, data: Record<string, unknown>) => {
        pending.push({ data, resolve: data.onResolve as (d: 'run' | 'skip') => void })
      },
      ...overrides
    } as never,
    true
  )
}

function okHooksResult(quickCommands: unknown) {
  return {
    status: 'ok',
    hasHooks: true,
    hooks: { scripts: {}, ...(quickCommands ? { quickCommands } : {}) },
    mayNeedUpdate: false
  }
}

const cachedProjectCommand: TerminalQuickCommand = {
  id: 'orca-yaml:dev-server',
  label: 'Dev server',
  action: 'terminal-command',
  command: 'echo stale-cached',
  appendEnter: true,
  scope: { type: 'repo', repoId: 'repo-1' }
}

describe('ensureProjectQuickCommandTrusted', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    __resetTrustPromptChainForTests()
    pending = []
    seedStore()
  })

  it('passes personal commands through without any hooks read', async () => {
    const personal: TerminalQuickCommand = {
      id: 'quick-command-1',
      label: 'Build',
      command: 'make',
      appendEnter: true
    }

    await expect(ensureProjectQuickCommandTrusted(personal)).resolves.toBe(personal)
    expect(checkRuntimeHooksMock).not.toHaveBeenCalled()
  })

  it('fails closed for a project command without repo scope', async () => {
    const orphan = { ...cachedProjectCommand, scope: { type: 'global' as const } }

    await expect(ensureProjectQuickCommandTrusted(orphan)).resolves.toBeNull()
    expect(checkRuntimeHooksMock).not.toHaveBeenCalled()
  })

  it('fails closed when the repo id is ambiguous across hosts', async () => {
    // Why: mirrors the store slice's dup-repo-id fail-safe — an ambiguous bare id
    // can't be routed to one owner host, so a click from a pre-collision menu must
    // not trust-check (and possibly run) another host's command.
    seedStore({
      repos: [
        { id: 'repo-1', displayName: 'Local' },
        { id: 'repo-1', displayName: 'SSH', connectionId: 'ssh-1' }
      ]
    })

    await expect(ensureProjectQuickCommandTrusted(cachedProjectCommand)).resolves.toBeNull()
    expect(checkRuntimeHooksMock).not.toHaveBeenCalled()
    expect(pending).toHaveLength(0)
  })

  it('returns the freshly read command, not the stale cached copy', async () => {
    checkRuntimeHooksMock.mockResolvedValue(
      okHooksResult([
        { action: 'terminal-command', label: 'Dev server', command: 'echo fresh-from-yaml' }
      ])
    )

    const promise = ensureProjectQuickCommandTrusted(cachedProjectCommand)
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    // The prompt shows the fresh file content, so execution must match it.
    expect(pending[0].data.scriptContent).toContain('echo fresh-from-yaml')
    pending[0].resolve('run')

    const trusted = await promise
    expect(trusted).toMatchObject({ id: 'orca-yaml:dev-server', command: 'echo fresh-from-yaml' })
    // The cache is synced to the read the user just approved.
    expect(
      (useAppStore.getState() as never as Record<string, Record<string, unknown[]>>)
        .projectQuickCommandsByRepo['repo-1']
    ).toHaveLength(1)
  })

  it('refuses a cached command that no longer exists in orca.yaml instead of auto-running it', async () => {
    // Why: with no quickCommands left in the file the trust content is empty
    // and ensureHooksConfirmed resolves 'run' without prompting — the stale
    // cached command must not slip through on that decision.
    checkRuntimeHooksMock.mockResolvedValue(okHooksResult(null))

    await expect(ensureProjectQuickCommandTrusted(cachedProjectCommand)).resolves.toBeNull()
    expect(pending).toHaveLength(0)
  })

  it('executes previously approved file content, not the stale cache, when no prompt is needed', async () => {
    // Why: an orca.yaml change can be reverted after the menu cached it; the
    // reverted content hash is already trusted so no prompt appears, and the
    // never-reviewed cached command must not be what runs.
    const approvedContent = '# quickCommands[1] (terminal-command) Dev server\n  echo approved-safe'
    seedStore({
      trustedOrcaHooks: {
        'repo-1': {
          quickCommands: { contentHash: await hashOrcaHookScript(approvedContent), approvedAt: 1 }
        }
      }
    })
    checkRuntimeHooksMock.mockResolvedValue(
      okHooksResult([
        { action: 'terminal-command', label: 'Dev server', command: 'echo approved-safe' }
      ])
    )

    const trusted = await ensureProjectQuickCommandTrusted(cachedProjectCommand)

    expect(pending).toHaveLength(0)
    expect(trusted).toMatchObject({ id: 'orca-yaml:dev-server', command: 'echo approved-safe' })
  })

  it('returns null when the user skips the prompt', async () => {
    checkRuntimeHooksMock.mockResolvedValue(
      okHooksResult([{ action: 'terminal-command', label: 'Dev server', command: 'echo fresh' }])
    )

    const promise = ensureProjectQuickCommandTrusted(cachedProjectCommand)
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    pending[0].resolve('skip')

    await expect(promise).resolves.toBeNull()
  })

  it('returns null when the hooks read fails', async () => {
    checkRuntimeHooksMock.mockResolvedValue({
      status: 'error',
      hasHooks: false,
      hooks: null,
      mayNeedUpdate: false
    })

    await expect(ensureProjectQuickCommandTrusted(cachedProjectCommand)).resolves.toBeNull()
    expect(pending).toHaveLength(0)
  })

  it('runs the cached command as-is for an always-trusted repo without re-reading hooks', async () => {
    seedStore({ trustedOrcaHooks: { 'repo-1': { all: { approvedAt: 1 } } } })

    await expect(ensureProjectQuickCommandTrusted(cachedProjectCommand)).resolves.toBe(
      cachedProjectCommand
    )
    expect(checkRuntimeHooksMock).not.toHaveBeenCalled()
  })
})
