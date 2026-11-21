// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'

// Why hoisted: the client platform is read once when the workspace module loads.
vi.hoisted(() => {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', platform: 'Win32' }
  })
})

import { createTestStore, seedStore } from '@/store/testing/app-store-test-fixture'
import { TEST_REPO } from '@/store/repos/repo.test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import type { WorktreeOperationRoute } from '@/lib/workspace/ownership/worktree-operation-route'
import { captureEditorFileOperationProvenance } from '@/lib/editor/file-operations/editor-file-operation-provenance'
import {
  connectedRuntimeStatus,
  publicRuntimeEnvironment
} from '@/runtime/rpc/testing/paired-runtime-environment-test-fixture'
import { getDefaultSettings } from '../../../../../../shared/orca-profiles/constants'
import type { HostAuthority } from '../../../../../../shared/execution-host/host-authority'
import type { SshConnectionState } from '../../../../../../shared/remote-runtime/ssh/ssh-types'
import { resolveOpenFileNewModelLineEnding } from '../buffer-text/editor-new-model-line-ending'
import { resolveEditorFileHostPlatform } from './editor-file-host-platform'

const WORKTREE_ID = 'repo::/home/me/repo'
const WSL_HOST = publicRuntimeEnvironment({
  id: 'wsl-ubuntu',
  orcadDeployment: { kind: 'wsl', distro: 'Ubuntu', localPort: 4100, remotePort: 4200 }
})

function file(
  route: WorktreeOperationRoute,
  filePath = '/home/me/repo/new.txt',
  authority?: HostAuthority
): OpenFile {
  return {
    id: 'file-1',
    worktreeId: WORKTREE_ID,
    filePath,
    relativePath: 'new.txt',
    mode: 'edit',
    language: 'plaintext',
    isDirty: false,
    runtimeEnvironmentId: route.runtimeEnvironmentId,
    operationProvenance: {
      ownershipProjection: 'explicit',
      generation: {
        route,
        ...(authority ? { authority } : {}),
        runtimeConnectionGeneration: null,
        runtimePairingRevision: undefined,
        runtimeSshGeneration: null,
        nestedSshGeneration: null,
        directSshGeneration: null
      }
    }
  }
}

function storeWith(openFile: OpenFile | null, endOfLine?: 'auto' | 'lf' | 'crlf') {
  const store = createTestStore()
  seedStore(store, {
    openFiles: openFile ? [openFile] : [],
    settings: { ...getDefaultSettings('/home/me'), editorEndOfLine: endOfLine }
  })
  return store
}

function sshState(remotePlatform?: 'linux'): SshConnectionState {
  return { targetId: 'box', status: 'connected', error: null, reconnectAttempt: 0, remotePlatform }
}

const eolOf = (store: ReturnType<typeof createTestStore>) =>
  resolveOpenFileNewModelLineEnding(
    store.getState(),
    store.getState().runtimeStatusByEnvironmentId,
    'file-1',
    'plaintext'
  )

const wslRoute = {
  executionHostId: 'runtime:wsl-ubuntu',
  runtimeEnvironmentId: 'wsl-ubuntu'
} as const
const sshRoute = { executionHostId: 'ssh:box', runtimeEnvironmentId: null } as const
const localRoute = { executionHostId: 'local', runtimeEnvironmentId: null } as const

describe('host OS of an open file, from a Windows client', () => {
  it('reads a WSL-host file opened through the app as Linux, before and after it reports', () => {
    const store = storeWith(null)
    const live = connectedRuntimeStatus('wsl-runtime', 1)
    store.setState({
      repos: [
        { ...TEST_REPO, id: 'repo', path: '/home/me/repo', executionHostId: 'runtime:wsl-ubuntu' }
      ],
      worktreesByRepo: {
        repo: [
          makeWorktree({
            id: WORKTREE_ID,
            repoId: 'repo',
            path: '/home/me/repo',
            hostId: 'runtime:wsl-ubuntu'
          })
        ]
      },
      runtimeEnvironments: [WSL_HOST]
    })
    const operationProvenance = captureEditorFileOperationProvenance(
      store.getState(),
      WORKTREE_ID,
      'wsl-ubuntu',
      true,
      'runtime:wsl-ubuntu'
    )
    // Captured authority is endpoint-relative: `local` means local to the WSL host.
    expect(operationProvenance.generation.authority).toEqual({
      endpoint: { kind: 'environment', environmentId: 'wsl-ubuntu' },
      at: 'local'
    })
    store.setState({ openFiles: [{ ...file(wslRoute), operationProvenance }] })
    expect(eolOf(store)).toBe('\n')

    store.setState({
      runtimeStatusByEnvironmentId: new Map([
        [
          'wsl-ubuntu',
          { ...live, status: live.status && { ...live.status, hostPlatform: 'linux' } }
        ]
      ])
    })
    expect(eolOf(store)).toBe('\n')
  })

  it('does not treat an SSH target reached through a WSL host as the distro', () => {
    const nested = file(
      { executionHostId: 'ssh:box', runtimeEnvironmentId: 'wsl-ubuntu' },
      '/srv/a',
      {
        endpoint: { kind: 'environment', environmentId: 'wsl-ubuntu' },
        at: 'ssh:box'
      }
    )
    const store = storeWith(nested)
    store.setState({ runtimeEnvironments: [WSL_HOST] })
    expect(
      resolveEditorFileHostPlatform(
        store.getState(),
        store.getState().runtimeStatusByEnvironmentId,
        nested
      )
    ).toBeNull()
  })

  it('reads a direct Linux SSH file once the host reports its OS', () => {
    const store = storeWith(file(sshRoute))
    store.setState({ sshConnectionStates: new Map([['box', sshState()]]) })
    expect(eolOf(store)).toBeNull()
    store.setState({ sshConnectionStates: new Map([['box', sshState('linux')]]) })
    expect(eolOf(store)).toBe('\n')
  })

  it('uses CRLF for a native Windows file and LF for a local WSL path', () => {
    expect(eolOf(storeWith(file(localRoute, 'C:\\repo\\new.txt')))).toBe('\r\n')
    const wslPath = file(localRoute, '\\\\wsl.localhost\\Ubuntu\\home\\me\\new.txt')
    expect(eolOf(storeWith(wslPath))).toBe('\n')
  })
})
