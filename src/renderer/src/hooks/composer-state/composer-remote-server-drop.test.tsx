// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { createRef } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import {
  clearRuntimeCompatibilityCacheForTests,
  markRuntimeEnvironmentCompatible
} from '@/runtime/runtime-rpc-client'
import {
  clearRuntimeEnvironmentConnectionGenerationsForTests,
  setRuntimeEnvironmentConnectionGenerationForTests
} from '@/store/slices/runtime-status'
import {
  FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY,
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../../shared/protocol-version'
import { resolveComposerAttachmentTarget } from './composer-attachment-target'
import { useAttachmentDropState } from './attachment-drop-state'

const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { error: toastError, message: vi.fn() } }))
vi.mock('@/store', () => ({
  useAppStore: Object.assign(() => undefined, { getState: () => ({}) })
}))

const ENVIRONMENT_ID = 'paired-server'
const REPO = { id: 'repo-1', path: '/srv/repo' }
const WORKTREE_SELECTOR = 'id:repo-1::/srv/repo'

type RuntimeCall = {
  selector: string
  method: string
  params: { worktree?: string; relativePath?: string; finalRelativePath?: string }
}

/** A paired server that resolves files.* only by a registered worktree id, like the real one. */
function installPairedServer(options: { onUpload?: () => void } = {}) {
  const files = new Set<string>()
  const calls: RuntimeCall[] = []
  const meta = { runtimeId: 'server-runtime' }
  const call = vi.fn(async (args: RuntimeCall) => {
    calls.push(args)
    if (args.method === 'status.get') {
      return {
        id: args.method,
        ok: true,
        result: {
          runtimeId: 'server-runtime',
          runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
          minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
          capabilities: [FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY]
        },
        _meta: meta
      }
    }
    if (args.params.worktree !== WORKTREE_SELECTOR) {
      return {
        id: args.method,
        ok: false,
        error: { code: 'selector_not_found', message: 'selector_not_found' },
        _meta: meta
      }
    }
    const relativePath = args.params.relativePath ?? ''
    if (args.method === 'files.stat') {
      return files.has(relativePath)
        ? { id: args.method, ok: true, result: { type: 'file', size: 1, mtime: 0 }, _meta: meta }
        : {
            id: args.method,
            ok: false,
            error: { code: 'not_found', message: 'not found' },
            _meta: meta
          }
    }
    if (args.method === 'files.createDir') {
      files.add(relativePath)
    }
    if (args.method === 'files.commitUpload') {
      files.add(args.params.finalRelativePath ?? '')
    }
    return { id: args.method, ok: true, result: { ok: true }, _meta: meta }
  })
  const upload = vi.fn(async () => {
    options.onUpload?.()
    return { byteLength: 1 }
  })
  const stage = vi.fn(async ({ sourcePaths }: { sourcePaths: string[] }) => ({
    sources: sourcePaths.map((sourcePath) => ({
      sourcePath,
      status: 'staged',
      name: sourcePath.slice(sourcePath.lastIndexOf('/') + 1),
      kind: 'file',
      entries: [
        { relativePath: '', kind: 'file', byteLength: 1, inode: 1, deviceId: 1, modifiedAtMs: 1 }
      ]
    }))
  }))
  Object.assign(window, {
    api: {
      fs: {
        importExternalPaths: vi.fn(),
        stageExternalPathsForRuntimeUpload: stage,
        uploadExternalFileToRuntime: upload
      },
      runtimeEnvironments: { call }
    }
  })
  return { calls, files, upload }
}

function renderComposerDrop(attached: string[]) {
  return renderHook(() => {
    const target = resolveComposerAttachmentTarget({
      selectedProjectGroup: null,
      selectedRepo: REPO,
      selectedRepoPath: REPO.path,
      selectedRepoExecutionHostId: `runtime:${ENVIRONMENT_ID}`,
      selectedRepoSettings: { activeRuntimeEnvironmentId: null },
      connectionId: null
    })
    return useAttachmentDropState({
      agentPromptRef: { current: '' },
      cancelPromptCaretFrame: () => {},
      connectionId: target.connectionId,
      promptCaretFrameRef: { current: null },
      promptTextareaRef: createRef<HTMLTextAreaElement>(),
      selectedRepoPath: target.path ?? undefined,
      selectedRepoSettings: target.settings,
      selectedWorktreeId: target.worktreeId,
      setAgentPrompt: () => {},
      setAttachmentPaths: (next) => {
        attached.splice(0, attached.length, ...(typeof next === 'function' ? next([]) : next))
      }
    })
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  clearRuntimeCompatibilityCacheForTests()
  clearRuntimeEnvironmentConnectionGenerationsForTests()
  replaceRuntimeEnvironmentRevisions([{ id: ENVIRONMENT_ID, createdAt: 1, pairingRevision: 3 }])
  setRuntimeEnvironmentConnectionGenerationForTests(ENVIRONMENT_ID, 1)
  markRuntimeEnvironmentCompatible(ENVIRONMENT_ID)
})

describe('composer drop on a project owned by a paired server (#16558)', () => {
  it('uploads into the project drops folder through the repo worktree', async () => {
    const server = installPairedServer()
    const attached: string[] = []
    const { result } = renderComposerDrop(attached)

    await act(async () => {
      await result.current.applyNativeDrop(['/client/shot.png'], () => true)
    })

    expect(toastError).not.toHaveBeenCalled()
    expect(attached).toEqual(['/srv/repo/.orca/drops/shot.png'])
    expect(server.files.has('.orca/drops/shot.png')).toBe(true)
    for (const call of server.calls.filter(({ method }) => method !== 'status.get')) {
      expect(call.selector).toBe(ENVIRONMENT_ID)
      expect(call.params.worktree).toBe(WORKTREE_SELECTOR)
    }
  })

  it('keeps both files when two drops share a basename', async () => {
    const server = installPairedServer()
    const attached: string[] = []
    const { result } = renderComposerDrop(attached)

    await act(async () => {
      await result.current.applyNativeDrop(['/client/a/shot.png'], () => true)
    })
    await act(async () => {
      await result.current.applyNativeDrop(['/client/b/shot.png'], () => true)
    })

    expect(server.files.has('.orca/drops/shot.png')).toBe(true)
    expect(server.files.has('.orca/drops/shot copy.png')).toBe(true)
    expect(attached).toContain('/srv/repo/.orca/drops/shot copy.png')
  })

  it('attaches nothing and commits nothing when the server disconnects mid-drop', async () => {
    const server = installPairedServer({
      onUpload: () => setRuntimeEnvironmentConnectionGenerationForTests(ENVIRONMENT_ID, 2)
    })
    const attached: string[] = []
    const { result } = renderComposerDrop(attached)

    await act(async () => {
      await result.current.applyNativeDrop(['/client/shot.png'], () => true)
    })

    expect(server.upload).toHaveBeenCalledOnce()
    expect(server.calls.map(({ method }) => method)).not.toContain('files.commitUpload')
    expect(attached).toEqual([])
    expect(toastError).toHaveBeenCalledOnce()
  })

  it('never sends temp cleanup to a replacement server after re-pairing', async () => {
    const server = installPairedServer({
      onUpload: () =>
        replaceRuntimeEnvironmentRevisions([
          { id: ENVIRONMENT_ID, createdAt: 1, pairingRevision: 4 }
        ])
    })
    const attached: string[] = []
    const { result } = renderComposerDrop(attached)

    await act(async () => {
      await result.current.applyNativeDrop(['/client/shot.png'], () => true)
    })

    const afterUpload = server.calls.map(({ method }) => method)
    expect(afterUpload).not.toContain('files.commitUpload')
    expect(afterUpload).not.toContain('files.delete')
    expect(attached).toEqual([])
  })
})
