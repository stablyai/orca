import { describe, expect, it } from 'vitest'
import { writeRuntimeFile } from './runtime-file-mutation-client'
import { FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY } from '../../../../../shared/file-access/files-runtime-capabilities'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../../../shared/protocol-version'
import {
  FILE_WRITE_DISK_PRECONDITION_RUNTIME_CAPABILITY,
  FILE_WRITE_IDENTICAL_RUNTIME_CAPABILITY
} from '../../../../../shared/file-write/file-write-disk-precondition'
import { getDiskBaselineSignature } from '../../../../../shared/file-write/disk-baseline-signature'
import { advanceRuntimeEnvironmentConnectionGeneration } from '@/store/slices/runtime-status/runtime-status-connection-generation'
import { replaceRuntimeEnvironmentRevisions } from '../../rpc/environment-revisions/runtime-environment-revision'
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

  it('does not take a re-paired host holding the text as proof a lost write landed', async () => {
    replaceRuntimeEnvironmentRevisions([{ id: 'env-1', createdAt: 1, pairingRevision: 1 }])
    serveHost({ enforcesPrecondition: true, diskContent: 'edited' })
    runtimeEnvironmentCall.mockImplementation(async () => {
      // The reply is lost, and the environment id is re-paired to another machine meanwhile.
      replaceRuntimeEnvironmentRevisions([{ id: 'env-1', createdAt: 1, pairingRevision: 2 }])
      return {
        id: 'rpc',
        ok: false,
        error: {
          code: 'runtime_timeout',
          message: 'Timed out waiting for the remote Orca runtime'
        },
        _meta: { runtimeId: 'remote-runtime' }
      }
    })

    await expect(
      writeRuntimeFile(remoteContext, '/remote/repo/file.ts', 'edited', undefined, precondition)
    ).rejects.toThrow('Timed out')
  })
})
