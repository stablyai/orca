import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import type { AppState } from '@/store/types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { getDefaultSettings } from '../../../../shared/constants'

const mocks = vi.hoisted(() => ({
  callRuntimeRpc: vi.fn()
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.callRuntimeRpc }))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(values?.[name]))
}))

import {
  nativeChatAttachFailedNotice,
  prepareNativeChatSessionAttachmentUpload,
  resolveNativeChatAttachmentOwner,
  resolveNativeChatAttachmentOwnerForWorktree,
  resolveNativeChatRuntimeSessionAttachmentOwner
} from './native-chat-attachment-upload'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import { AGENT_SESSION_ATTACHMENTS_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { repoFixture, worktreeFixture } from './native-chat-workspace-test-fixtures'

function terminalTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: 'tab-1',
    ptyId: null,
    worktreeId: 'wt-1',
    title: 'Terminal 1',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    ...overrides
  }
}

type OwnerState = Parameters<typeof resolveNativeChatAttachmentOwner>[0]

function state(overrides: Partial<OwnerState> = {}): OwnerState {
  return {
    detectedWorktreesByRepo: {},
    folderWorkspaces: [],
    floatingWorkspacePath: null,
    projectGroups: [],
    repos: [repoFixture({ connectionId: null })],
    settings: { ...getDefaultSettings('/home/me'), activeRuntimeEnvironmentId: null },
    sshConnectionStates: new Map(),
    tabsByWorktree: {
      'wt-1': [terminalTab()]
    },
    unifiedTabsByWorktree: {},
    worktreesByRepo: {
      repo: [
        worktreeFixture('wt-1', '/repo/worktree', {
          hostId:
            overrides.repos?.length === 0
              ? undefined
              : getRepoExecutionHostId(overrides.repos?.[0] ?? { connectionId: null })
        })
      ]
    },
    ...overrides
  }
}

describe('resolveNativeChatAttachmentOwner', () => {
  it('resolves a local repo worktree to local', () => {
    expect(resolveNativeChatAttachmentOwner(state(), 'tab-1')).toEqual({ kind: 'local' })
  })

  it('resolves a structured tab owner directly from its worktree', () => {
    expect(resolveNativeChatAttachmentOwnerForWorktree(state(), 'wt-1')).toEqual({
      kind: 'local'
    })
  })

  it('refuses client files for an SSH-owned worktree, whatever its connection state', () => {
    const sshState = state({ repos: [repoFixture({ connectionId: 'conn-1' })] })
    expect(resolveNativeChatAttachmentOwner(sshState, 'tab-1')).toEqual({ kind: 'remote' })
    expect(resolveNativeChatAttachmentOwnerForWorktree(sshState, 'wt-1')).toEqual({
      kind: 'remote'
    })
  })

  it('refuses client files for a runtime-owned repo but saves clipboard images on that server', () => {
    // #27997: a managed SSH host is a runtime owner; its agent reads the server's own temp dir.
    expect(
      resolveNativeChatAttachmentOwner(
        state({
          repos: [{ id: 'repo', connectionId: null, executionHostId: 'runtime:env-1' }] as never
        }),
        'tab-1'
      )
    ).toEqual({ kind: 'remote', clipboardImageEnvironmentId: 'env-1' })
  })

  it('takes no clipboard image for a server-nested SSH host the server does not serve', () => {
    expect(
      resolveNativeChatAttachmentOwner(
        state({
          repos: [repoFixture({ connectionId: 'jetson', executionHostId: 'runtime:env-1' })]
        }),
        'tab-1'
      )
    ).toEqual({ kind: 'remote' })
  })

  it('keeps a recorded local workspace local when a runtime is focused', () => {
    expect(
      resolveNativeChatAttachmentOwner(
        state({ settings: { activeRuntimeEnvironmentId: 'env-9' } as AppState['settings'] }),
        'tab-1'
      )
    ).toEqual({ kind: 'local' })
  })

  it('reports not-ready when the tab has no worktree owner', () => {
    expect(resolveNativeChatAttachmentOwner(state({ tabsByWorktree: {} }), 'tab-1')).toEqual({
      kind: 'not-ready'
    })
  })

  it('reports not-ready when the backing repo has not hydrated', () => {
    expect(resolveNativeChatAttachmentOwner(state({ repos: [] }), 'tab-1')).toEqual({
      kind: 'not-ready'
    })
  })
})

describe('a structured chat on a paired server', () => {
  const owner = {
    kind: 'runtime-session' as const,
    environmentId: 'env-1',
    pairingRevision: 7,
    sessionId: 'session-1'
  }

  beforeEach(() => {
    replaceRuntimeEnvironmentRevisions([{ id: 'env-1', createdAt: 1, pairingRevision: 7 }])
    mocks.callRuntimeRpc.mockReset()
  })

  it('owns its attachments by the server it runs on and that pairing', () => {
    expect(
      resolveNativeChatRuntimeSessionAttachmentOwner({
        sessionId: 'session-1',
        runtimeEnvironmentId: 'env-1'
      })
    ).toEqual(owner)
    expect(
      resolveNativeChatRuntimeSessionAttachmentOwner({
        sessionId: 'session-1',
        runtimeEnvironmentId: 'env-gone'
      })
    ).toEqual({ kind: 'not-ready' })
  })

  it('asks the server, pinned to the pairing, and uploads only where it keeps a store', async () => {
    mocks.callRuntimeRpc.mockResolvedValue({
      runtimeId: 'runtime-a',
      capabilities: [AGENT_SESSION_ATTACHMENTS_RUNTIME_CAPABILITY]
    })
    await expect(prepareNativeChatSessionAttachmentUpload(owner)).resolves.toEqual({
      ok: true,
      target: {
        environmentId: 'env-1',
        sessionId: 'session-1',
        expectedEnvironmentPairingRevision: 7,
        expectedEnvironmentRuntimeId: 'runtime-a'
      }
    })
    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'status.get',
      undefined,
      expect.objectContaining({ expectedEnvironmentPairingRevision: 7 })
    )
  })

  it('tells the user to update an older server instead of uploading', async () => {
    mocks.callRuntimeRpc.mockResolvedValue({ runtimeId: 'runtime-a', capabilities: [] })
    await expect(prepareNativeChatSessionAttachmentUpload(owner)).resolves.toEqual({
      ok: false,
      notice:
        'This needs a newer Orca on the computer running this chat. Update Orca there, then try again.'
    })
  })
})

describe('nativeChatAttachFailedNotice', () => {
  it('ends the shared cause with one full stop, whatever script it is written in', () => {
    expect(nativeChatAttachFailedNotice(['a.mov'], 'over the 50 MB limit')).toBe(
      "Couldn't attach a.mov. over the 50 MB limit."
    )
    expect(nativeChatAttachFailedNotice(['a'], 'サポートされていないファイル形式です。')).toBe(
      "Couldn't attach a. サポートされていないファイル形式です。"
    )
    expect(nativeChatAttachFailedNotice(['a'], '不支持的文件类型！')).toBe(
      "Couldn't attach a. 不支持的文件类型！"
    )
    expect(nativeChatAttachFailedNotice(['a', 'b'])).toBe("Couldn't attach a, b.")
  })
})
