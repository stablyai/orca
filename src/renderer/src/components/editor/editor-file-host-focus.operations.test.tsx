// @vitest-environment happy-dom
import { act, useLayoutEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { makeWorktree, TEST_REPO } from '@/store/slices/store-test-helpers'
import type { OpenFile } from '@/store/slices/editor'
import type * as RuntimeFileClient from '@/runtime/runtime-file-client'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { FileContent } from './editor-panel-content-types'
import { createEditorSaveQueue } from './editor-save-queue'
import {
  useEditorPanelFileContentLoader,
  type EditorPanelFileContentLoader
} from './useEditorPanelFileContentLoader'

const calls = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }))
vi.mock('@/runtime/runtime-file-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeFileClient>()),
  readRuntimeFileContent: calls.read,
  writeRuntimeFile: calls.write
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function ReadProbe({
  file,
  ready
}: {
  file: OpenFile
  ready: (load: EditorPanelFileContentLoader) => void
}) {
  const [, setFileContents] = useState<Record<string, FileContent>>({})
  const load = useEditorPanelFileContentLoader({
    fileLoadRetryAttemptsRef: useRef({}),
    fileReadGenerationCounterRef: useRef(0),
    fileReadGenerationRef: useRef({}),
    openFilesRef: useRef([file]),
    outstandingFileReadsRef: useRef({}),
    setFileContents
  })
  useLayoutEffect(() => {
    ready(load)
  }, [load, ready])
  return null
}

afterEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  calls.read.mockReset()
  calls.write.mockReset()
})

describe('editor operations across host focus changes', () => {
  it.each([
    { host: 'local', environment: null, connection: undefined },
    { host: 'runtime:file-host', environment: 'file-host', connection: undefined },
    { host: 'ssh:file-target', environment: null, connection: 'file-target' }
  ] satisfies {
    host: ExecutionHostId
    environment: string | null
    connection: string | undefined
  }[])('keeps delayed read and save on $host', async ({ host, environment, connection }) => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    useAppStore.setState(useAppStore.getInitialState(), true)
    const worktreeId = 'repo1::/workspace/repo'
    useAppStore.setState({
      repos: [{ ...TEST_REPO, path: '/workspace/repo', connectionId: connection }],
      worktreesByRepo: {
        repo1: [
          makeWorktree({
            id: worktreeId,
            repoId: 'repo1',
            path: '/workspace/repo',
            ...(host === 'local' ? {} : { hostId: host }),
            ...(environment ? { runtimeOwnerEnvironmentId: environment } : {})
          })
        ]
      },
      settings: createGlobalSettingsFixture({ activeRuntimeEnvironmentId: null }),
      activeWorktreeId: worktreeId,
      activeWorkspaceExecutionHostId: 'runtime:other-host',
      sshConnectionStates: new Map([
        [
          'file-target',
          {
            targetId: 'file-target',
            status: 'connected',
            error: null,
            reconnectAttempt: 0,
            connectionGeneration: 7
          }
        ]
      ]),
      recordFeatureInteraction: vi.fn()
    })
    const fileId = useAppStore.getState().openFile({
      filePath: '/workspace/repo/file.txt',
      relativePath: 'file.txt',
      worktreeId,
      language: 'plaintext',
      mode: 'edit'
    })
    const file = useAppStore.getState().openFiles.find((entry) => entry.id === fileId)
    if (!file) {
      throw new Error('Expected the opened file')
    }
    const read = deferred<FileContent>()
    const write = deferred<void>()
    calls.read.mockReturnValueOnce(read.promise)
    calls.write.mockReturnValueOnce(write.promise)
    const container = document.body.appendChild(document.createElement('div'))
    const root = createRoot(container)
    const queue = createEditorSaveQueue(useAppStore)
    const probe: { load?: EditorPanelFileContentLoader } = {}
    try {
      act(() =>
        root.render(
          <ReadProbe
            file={file}
            ready={(load) => {
              probe.load = load
            }}
          />
        )
      )
      const load = probe.load
      if (!load) {
        throw new Error('Expected the content loader')
      }
      const pendingRead = load(file.filePath, file.id, worktreeId, file.relativePath)
      await vi.waitFor(() => expect(calls.read).toHaveBeenCalledTimes(1))
      useAppStore.setState({
        activeWorkspaceExecutionHostId: 'runtime:third-host',
        settings: createGlobalSettingsFixture({ activeRuntimeEnvironmentId: 'third-host' })
      })
      expect(calls.read.mock.calls[0]?.[0]).toMatchObject({
        settings: { activeRuntimeEnvironmentId: environment },
        connectionId: connection
      })
      await act(async () => {
        read.resolve({ content: 'original', isBinary: false })
        await pendingRead
      })
      useAppStore.getState().setEditorDraft(fileId, 'saved draft')
      useAppStore.getState().markFileDirty(fileId, true)
      const pendingSave = queue.queueSave(file, 'saved draft')
      await vi.waitFor(() => expect(calls.write).toHaveBeenCalledTimes(1))
      useAppStore.setState({ activeWorkspaceExecutionHostId: 'runtime:fourth-host' })
      expect(calls.write.mock.calls[0]?.[0]).toMatchObject({
        settings: { activeRuntimeEnvironmentId: environment },
        ...(connection ? { connectionId: connection } : {}),
        expectedExecutionHostId: connection ? host : 'local'
      })
      expect(calls.write.mock.calls[0]?.slice(1, 3)).toEqual([file.filePath, 'saved draft'])
      write.resolve()
      await pendingSave
      expect(useAppStore.getState().openFiles.find((entry) => entry.id === fileId)?.isDirty).toBe(
        false
      )
      expect(
        useAppStore
          .getState()
          .unifiedTabsByWorktree[worktreeId]?.find((tab) => tab.entityId === fileId)
          ?.executionHostId
      ).toBe(host)
    } finally {
      queue.dispose()
      act(() => root.unmount())
      container.remove()
    }
  })
})
