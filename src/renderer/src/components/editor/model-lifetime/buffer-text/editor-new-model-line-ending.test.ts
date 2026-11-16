// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'

// Why hoisted: the client platform is read once when the workspace module loads.
vi.hoisted(() => {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', platform: 'Win32' }
  })
})

import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import { createTestStore, seedStore } from '@/store/testing/app-store-test-fixture'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import type { WorktreeOperationRoute } from '@/lib/workspace/ownership/worktree-operation-route'
import {
  connectedRuntimeStatus,
  publicRuntimeEnvironment
} from '@/runtime/rpc/testing/paired-runtime-environment-test-fixture'
import { getDefaultSettings } from '../../../../../../shared/orca-profiles/constants'
import {
  applyNewModelLineEnding,
  resolveEditorFileHostPlatform,
  resolveOpenFileNewModelLineEnding
} from './editor-new-model-line-ending'
import {
  isProgrammaticContentSyncInFlight,
  resetProgrammaticContentSyncForTests
} from './monaco-programmatic-sync'

const WSL_HOST = publicRuntimeEnvironment({
  id: 'wsl-ubuntu',
  orcadDeployment: { kind: 'wsl', distro: 'Ubuntu', localPort: 4100, remotePort: 4200 }
})

function file(route: WorktreeOperationRoute, filePath = '/home/me/repo/new.txt'): OpenFile {
  return {
    id: 'file-1',
    worktreeId: 'repo::/home/me/repo',
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
        runtimeConnectionGeneration: null,
        runtimePairingRevision: undefined,
        runtimeSshGeneration: null,
        nestedSshGeneration: null,
        directSshGeneration: null
      }
    }
  }
}

function storeWith(openFile: OpenFile, endOfLine?: 'auto' | 'lf' | 'crlf') {
  const store = createTestStore()
  seedStore(store, {
    openFiles: [openFile],
    settings: { ...getDefaultSettings('/home/me'), editorEndOfLine: endOfLine }
  })
  return store
}

const wslRoute = {
  executionHostId: 'runtime:wsl-ubuntu',
  runtimeEnvironmentId: 'wsl-ubuntu'
} as const
const sshRoute = { executionHostId: 'ssh:box', runtimeEnvironmentId: null } as const
const localRoute = { executionHostId: 'local', runtimeEnvironmentId: null } as const

afterEach(() => resetProgrammaticContentSyncForTests())

describe('line ending for a file with no line breaks yet', () => {
  it('uses LF for a file on a WSL host, before and after it reports its OS', () => {
    const store = storeWith(file(wslRoute))
    store.setState({ runtimeEnvironments: [WSL_HOST] })
    expect(resolveOpenFileNewModelLineEnding(store.getState(), 'file-1', 'plaintext')).toBe('\n')

    const live = connectedRuntimeStatus('wsl-runtime', 1)
    store.setState({
      runtimeStatusByEnvironmentId: new Map([
        [
          'wsl-ubuntu',
          { ...live, status: live.status && { ...live.status, hostPlatform: 'linux' } }
        ]
      ])
    })
    expect(resolveEditorFileHostPlatform(store.getState(), file(wslRoute))).toBe('linux')
  })

  it('uses LF for a file on a Linux SSH host from a Windows client', () => {
    const store = storeWith(file(sshRoute))
    expect(resolveOpenFileNewModelLineEnding(store.getState(), 'file-1', 'plaintext')).toBeNull()
    store.setState({
      sshConnectionStates: new Map([
        [
          'box',
          {
            targetId: 'box',
            status: 'connected',
            error: null,
            reconnectAttempt: 0,
            remotePlatform: 'linux'
          }
        ]
      ])
    })
    expect(resolveOpenFileNewModelLineEnding(store.getState(), 'file-1', 'plaintext')).toBe('\n')
  })

  it('uses CRLF for a native Windows file and LF for a local WSL path', () => {
    const native = storeWith(file(localRoute, 'C:\\repo\\new.txt'))
    expect(resolveOpenFileNewModelLineEnding(native.getState(), 'file-1', 'plaintext')).toBe('\r\n')
    const wslPath = storeWith(file(localRoute, '\\\\wsl.localhost\\Ubuntu\\home\\me\\new.txt'))
    expect(resolveOpenFileNewModelLineEnding(wslPath.getState(), 'file-1', 'plaintext')).toBe('\n')
  })

  it('lets the End of Line setting override the host', () => {
    const store = storeWith(file(localRoute, 'C:\\repo\\new.txt'), 'lf')
    expect(resolveOpenFileNewModelLineEnding(store.getState(), 'file-1', 'plaintext')).toBe('\n')
    const crlf = storeWith(file(wslRoute), 'crlf')
    expect(resolveOpenFileNewModelLineEnding(crlf.getState(), 'file-1', 'plaintext')).toBe('\r\n')
  })
})

describe('applyNewModelLineEnding', () => {
  it('switches a model without line breaks and hides the switch from dirty tracking', () => {
    const model = monaco.editor.createModel('', 'plaintext')
    model.setEOL(monaco.editor.EndOfLineSequence.CRLF)
    let echoed = false
    const listener = model.onDidChangeContent(() => {
      echoed = !isProgrammaticContentSyncInFlight('key')
    })
    applyNewModelLineEnding(model, '\n', 'key')
    expect(model.getEOL()).toBe('\n')
    expect(echoed).toBe(false)
    listener.dispose()
    model.dispose()
  })

  it('keeps the ending of a file that already has line breaks', () => {
    const model = monaco.editor.createModel('a\r\nb\r\n', 'plaintext')
    applyNewModelLineEnding(model, '\n', 'key')
    expect(model.getEOL()).toBe('\r\n')
    expect(model.getValue()).toBe('a\r\nb\r\n')
    model.dispose()
  })
})
