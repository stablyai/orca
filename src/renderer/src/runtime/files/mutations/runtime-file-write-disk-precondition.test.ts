import { describe, expect, it } from 'vitest'
import { writeRuntimeFile } from './runtime-file-mutation-client'
import { FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY } from '../../../../../shared/file-access/files-runtime-capabilities'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../../../shared/remote-runtime/protocol/protocol-version'
import {
  FILE_WRITE_DISK_PRECONDITION_RUNTIME_CAPABILITY,
  FILE_WRITE_IDENTICAL_RUNTIME_CAPABILITY
} from '../../../../../shared/file-write/file-write-disk-precondition'
import { getDiskBaselineSignature } from '../../../../../shared/file-write/disk-baseline-signature'
import { advanceRuntimeEnvironmentConnectionGeneration } from '@/store/slices/runtime-status/runtime-status-connection-generation'

import {
  installRuntimeFileClientEnvironment,
  runtimeEnvironmentCall,
  runtimeEnvironmentTransportCall,
  type RuntimeRpcRequest
} from '../runtime-file-client-test-harness'

installRuntimeFileClientEnvironment()

const remoteContext = {
  target: { kind: 'environment' as const, environmentId: 'env-1' },
  worktreeId: 'wt-1',
  worktreePath: '/remote/repo'
}
const precondition = { expectedSignature: getDiskBaselineSignature('original') }
const ENOENT_MESSAGE = "ENOENT: no such file or directory, stat '/remote/repo/file.ts'"

function rpcOk(result: unknown) {
  return { id: 'rpc', ok: true, result, _meta: { runtimeId: 'remote-runtime' } }
}

function serveHost(options: {
  enforcesPrecondition: boolean
  identicalNoop?: boolean
  diskContent?: string
  readError?: string
  readErrorCode?: string
  onRead?: () => void
}): void {
  runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeRpcRequest) => {
    if (args.method === 'status.get') {
      return Promise.resolve(
        rpcOk({
          runtimeId: 'remote-runtime',
          runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
          minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
          capabilities: [
            FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY,
            ...(options.enforcesPrecondition
              ? [
                  FILE_WRITE_DISK_PRECONDITION_RUNTIME_CAPABILITY,
                  ...(options.identicalNoop === false
                    ? []
                    : [FILE_WRITE_IDENTICAL_RUNTIME_CAPABILITY])
                ]
              : [])
          ]
        })
      )
    }
    if (args.method === 'files.read') {
      options.onRead?.()
      return Promise.resolve(
        options.diskContent === undefined
          ? {
              id: 'rpc',
              ok: false,
              error: {
                code: options.readErrorCode ?? 'runtime_error',
                message: options.readError ?? ENOENT_MESSAGE
              }
            }
          : rpcOk({ content: options.diskContent, truncated: false, byteLength: 0 })
      )
    }
    return runtimeEnvironmentCall(args)
  })
}

function writeCalls(): RuntimeRpcRequest[] {
  return runtimeEnvironmentCall.mock.calls
    .map(([args]) => args)
    .filter((args) => args.method === 'files.write' || args.method === 'files.writeIfUnchanged')
}

describe('writeRuntimeFile disk precondition', () => {
  it('refuses to send when the runtime connection changes after the probe', async () => {
    serveHost({
      enforcesPrecondition: false,
      diskContent: 'original',
      onRead: () => advanceRuntimeEnvironmentConnectionGeneration('env-1')
    })

    await expect(
      writeRuntimeFile(remoteContext, '/remote/repo/file.ts', 'edited', undefined, precondition)
    ).rejects.toThrow('Runtime connection changed')
    expect(writeCalls()).toHaveLength(0)
  })
})
