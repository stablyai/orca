import { beforeEach, vi } from 'vitest'
import type { Mock } from 'vitest'
import { clearRuntimeCompatibilityCacheForTests } from './runtime-rpc-client'
import { replaceRuntimeEnvironmentRevisions } from './runtime-environment-revision'
import { clearLegacyQuickOpenInventoryCacheForTests } from './runtime-legacy-quick-open-inventory'
import {
  FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY,
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../shared/protocol-version'

/** One stub stands in for many differently shaped preload methods, so arguments stay open. */
export type PreloadStub = Mock<(...args: never[]) => unknown>

/** Mirrors the preload `runtimeEnvironments.call` request shape the suites assert on. */
export type RuntimeRpcRequest = {
  selector?: string
  method: string
  params?: unknown
  timeoutMs?: number
  expectedEnvironmentPairingRevision?: number
}

export type RuntimeRpcStub = Mock<(args: RuntimeRpcRequest) => unknown>

export type RuntimeSubscriptionCallbacks = {
  onResponse: (response: unknown) => void
  onClose: () => void
}

export type RuntimeSubscribeStub = Mock<
  (args: RuntimeRpcRequest, callbacks: RuntimeSubscriptionCallbacks) => unknown
>

export const fsReadFile: PreloadStub = vi.fn()
export const fsWriteFile: PreloadStub = vi.fn()
export const fsOnChanged: PreloadStub = vi.fn()
export const fsCopy: PreloadStub = vi.fn()
export const fsCreateDir: PreloadStub = vi.fn()
export const fsCreateFile: PreloadStub = vi.fn()
export const fsRename: PreloadStub = vi.fn()
export const fsDeletePath: PreloadStub = vi.fn()
export const fsStat: PreloadStub = vi.fn()
export const fsPathExists: PreloadStub = vi.fn()
export const fsSearch: PreloadStub = vi.fn()
export const fsListFiles: PreloadStub = vi.fn()
export const fsCancelListFiles: PreloadStub = vi.fn()
export const fsDownloadFile: PreloadStub = vi.fn()
export const fsSaveDownloadedFile: PreloadStub = vi.fn()
export const fsStartDownloadedFile: PreloadStub = vi.fn()
export const fsAppendDownloadedFileChunk: PreloadStub = vi.fn()
export const fsFinishDownloadedFile: PreloadStub = vi.fn()
export const fsCancelDownloadedFile: PreloadStub = vi.fn()
export const fsImportExternalPaths: PreloadStub = vi.fn()
export const fsStageExternalPathsForRuntimeUpload: PreloadStub = vi.fn()
export const runtimeEnvironmentCall: RuntimeRpcStub = vi.fn()
export const runtimeEnvironmentTransportCall: RuntimeRpcStub = vi.fn()
export const runtimeEnvironmentSubscribe: RuntimeSubscribeStub = vi.fn()
export const runtimeCall: PreloadStub = vi.fn()

/** Registers the stubbed window.api fs/runtime surface shared by the runtime file client suites. */
export function installRuntimeFileClientEnvironment(): void {
  beforeEach(() => {
    delete (globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__
    clearRuntimeCompatibilityCacheForTests()
    clearLegacyQuickOpenInventoryCacheForTests()
    replaceRuntimeEnvironmentRevisions([])
    fsReadFile.mockReset()
    fsWriteFile.mockReset()
    fsOnChanged.mockReset()
    fsCopy.mockReset()
    fsCreateDir.mockReset()
    fsCreateFile.mockReset()
    fsRename.mockReset()
    fsDeletePath.mockReset()
    fsStat.mockReset()
    fsPathExists.mockReset()
    fsSearch.mockReset()
    fsListFiles.mockReset()
    fsCancelListFiles.mockReset()
    fsCancelListFiles.mockResolvedValue(undefined)
    fsDownloadFile.mockReset()
    fsSaveDownloadedFile.mockReset()
    fsStartDownloadedFile.mockReset()
    fsAppendDownloadedFileChunk.mockReset()
    fsFinishDownloadedFile.mockReset()
    fsCancelDownloadedFile.mockReset()
    fsImportExternalPaths.mockReset()
    fsStageExternalPathsForRuntimeUpload.mockReset()
    runtimeEnvironmentCall.mockReset()
    runtimeEnvironmentTransportCall.mockReset()
    runtimeEnvironmentSubscribe.mockReset()
    runtimeCall.mockReset()
    runtimeEnvironmentTransportCall.mockImplementation((args: { method: string }) => {
      if (args.method === 'status.get') {
        return Promise.resolve({
          id: 'status',
          ok: true,
          result: {
            runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
            minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
            capabilities: [FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY]
          },
          _meta: { runtimeId: 'remote-runtime' }
        })
      }
      return runtimeEnvironmentCall(args)
    })
    vi.stubGlobal('window', {
      api: {
        fs: {
          readFile: fsReadFile,
          writeFile: fsWriteFile,
          onFsChanged: fsOnChanged,
          copy: fsCopy,
          createDir: fsCreateDir,
          createFile: fsCreateFile,
          rename: fsRename,
          deletePath: fsDeletePath,
          stat: fsStat,
          pathExists: fsPathExists,
          search: fsSearch,
          listFiles: fsListFiles,
          cancelListFiles: fsCancelListFiles,
          downloadFile: fsDownloadFile,
          saveDownloadedFile: fsSaveDownloadedFile,
          startDownloadedFile: fsStartDownloadedFile,
          appendDownloadedFileChunk: fsAppendDownloadedFileChunk,
          finishDownloadedFile: fsFinishDownloadedFile,
          cancelDownloadedFile: fsCancelDownloadedFile,
          importExternalPaths: fsImportExternalPaths,
          stageExternalPathsForRuntimeUpload: fsStageExternalPathsForRuntimeUpload
        },
        runtime: { call: runtimeCall },
        runtimeEnvironments: {
          call: runtimeEnvironmentTransportCall,
          subscribe: runtimeEnvironmentSubscribe
        }
      }
    })
  })
}
