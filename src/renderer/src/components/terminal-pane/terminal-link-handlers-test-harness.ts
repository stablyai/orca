import { afterEach, beforeEach, vi } from 'vitest'
import { registerHttpLinkStoreAccessor } from '@/lib/http-link-routing'
import { getConnectionId } from '@/lib/connection-context'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '@/runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '@/runtime/runtime-rpc-client'
import type { TerminalLinkTestDoubles } from './terminal-link-handlers-test-fixtures'

export function setPlatform(userAgent: string): void {
  vi.stubGlobal('navigator', { userAgent })
}

export function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

export async function flushAsyncWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

export async function flushDoubleRaf(): Promise<void> {
  await flushAsyncWork()
  await flushAsyncWork()
}

/** Per-spec window/IPC stubs plus mock resets every terminal link suite shares. */
export function installTerminalLinkTestEnvironment(doubles: TerminalLinkTestDoubles): void {
  const {
    openUrlMock,
    openFileUriMock,
    openFilePathMock,
    authorizeExternalPathMock,
    statMock,
    fsPathExistsMock,
    runtimeEnvironmentCallMock,
    runtimeEnvironmentTransportCallMock,
    storeState
  } = doubles

  beforeEach(() => {
    clearRuntimeCompatibilityCacheForTests()
    vi.clearAllMocks()
    runtimeEnvironmentTransportCallMock.mockReset()
    runtimeEnvironmentTransportCallMock.mockImplementation(
      (args: RuntimeEnvironmentCallRequest) => {
        return (
          createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCallMock(args)
        )
      }
    )
    vi.mocked(getConnectionId).mockReturnValue(null)
    openFilePathMock.mockResolvedValue(true)
    storeState.settings = undefined
    storeState.activeFileIdByWorktree = {}
    storeState.openFiles = []
    storeState.worktreesByRepo = {}
    registerHttpLinkStoreAccessor(() => storeState)
    vi.stubGlobal('window', {
      dispatchEvent: vi.fn(),
      api: {
        shell: {
          openUrl: openUrlMock,
          openFileUri: openFileUriMock,
          openFilePath: openFilePathMock,
          pathExists: vi.fn().mockResolvedValue(true)
        },
        fs: {
          authorizeExternalPath: authorizeExternalPathMock,
          pathExists: fsPathExistsMock,
          stat: statMock
        },
        runtimeEnvironments: { call: runtimeEnvironmentTransportCallMock }
      }
    })
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
      return setTimeout(() => callback(0), 0) as unknown as number
    })
    vi.stubGlobal('cancelAnimationFrame', (handle: number): void => {
      clearTimeout(handle)
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })
}
