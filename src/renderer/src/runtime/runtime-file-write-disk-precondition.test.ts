import { describe, expect, it } from 'vitest'
import { writeRuntimeFile } from './runtime-file-mutation-client'
import {
  FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY,
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../shared/protocol-version'
import { FILE_WRITE_DISK_PRECONDITION_RUNTIME_CAPABILITY } from '../../../shared/file-write-disk-precondition'
import { getDiskBaselineSignature } from '../../../shared/disk-baseline-signature'
import { advanceRuntimeEnvironmentConnectionGeneration } from '@/store/slices/runtime-status-connection-generation'
import { replaceRuntimeEnvironmentRevisions } from './runtime-environment-revision'
import {
  fsWriteFile,
  installRuntimeFileClientEnvironment,
  runtimeEnvironmentCall,
  runtimeEnvironmentTransportCall,
  type RuntimeRpcRequest
} from './runtime-file-client-test-harness'

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
  diskContent?: string
  readError?: string
  readErrorCode?: string
  onRead?: () => void
  onStatus?: () => void
}): void {
  runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeRpcRequest) => {
    if (args.method === 'status.get') {
      options.onStatus?.()
      return Promise.resolve(
        rpcOk({
          runtimeId: 'remote-runtime',
          runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
          minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
          capabilities: [
            FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY,
            ...(options.enforcesPrecondition
              ? [FILE_WRITE_DISK_PRECONDITION_RUNTIME_CAPABILITY]
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
  it('sends the precondition to a local writer and returns its refusal', async () => {
    fsWriteFile.mockResolvedValue({ ok: false, diskConflict: 'changed' })

    const result = await writeRuntimeFile(
      { target: { kind: 'local' }, worktreeId: 'wt-1', worktreePath: '/repo' },
      '/repo/file.ts',
      'edited',
      undefined,
      precondition
    )

    expect(result).toEqual({ ok: false, diskConflict: 'changed' })
    expect(fsWriteFile).toHaveBeenCalledWith(
      expect.objectContaining({ diskPrecondition: precondition })
    )
  })

  it('cannot write through an older server reached after a supporting server was probed', async () => {
    // The shared socket reconnected to an older server between the capability verdict and the send.
    serveHost({ enforcesPrecondition: true })
    const unguardedWrites: RuntimeRpcRequest[] = []
    runtimeEnvironmentCall.mockImplementation((args: RuntimeRpcRequest) => {
      if (args.method === 'files.write') {
        unguardedWrites.push(args)
        return Promise.resolve(rpcOk({ ok: true }))
      }
      return Promise.resolve({
        id: 'rpc',
        ok: false,
        error: { code: 'method_not_found', message: `Unknown method: ${args.method}` },
        _meta: { runtimeId: 'remote-runtime' }
      })
    })

    await expect(
      writeRuntimeFile(remoteContext, '/remote/repo/file.ts', 'edited', undefined, precondition)
    ).rejects.toThrow()
    expect(unguardedWrites).toHaveLength(0)
  })

  it('lets a host that enforces the precondition compare at write time', async () => {
    serveHost({ enforcesPrecondition: true })
    runtimeEnvironmentCall.mockResolvedValue(rpcOk({ ok: false, diskConflict: 'missing' }))

    const result = await writeRuntimeFile(
      remoteContext,
      '/remote/repo/file.ts',
      'edited',
      undefined,
      precondition
    )

    expect(result).toEqual({ ok: false, diskConflict: 'missing' })
    expect(writeCalls()).toHaveLength(1)
    expect(writeCalls()[0]?.params).toMatchObject({ diskPrecondition: precondition })
    expect(runtimeEnvironmentTransportCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'files.read' })
    )
  })

  it('compares from the client before writing through an older host', async () => {
    serveHost({ enforcesPrecondition: false, diskContent: 'original' })
    runtimeEnvironmentCall.mockResolvedValue(rpcOk({ ok: true }))

    const result = await writeRuntimeFile(
      remoteContext,
      '/remote/repo/file.ts',
      'edited',
      undefined,
      precondition
    )

    expect(result).toEqual({ ok: true })
    expect(writeCalls()).toHaveLength(1)
    expect(writeCalls()[0]?.params).not.toHaveProperty('diskPrecondition')
  })

  it("decides support from the write path's own status probe, one per save", async () => {
    serveHost({ enforcesPrecondition: false, diskContent: 'original' })
    runtimeEnvironmentCall.mockResolvedValue(rpcOk({ ok: true }))

    for (let save = 0; save < 3; save += 1) {
      await writeRuntimeFile(
        remoteContext,
        '/remote/repo/file.ts',
        'edited',
        undefined,
        precondition
      )
    }

    const statusCalls = runtimeEnvironmentTransportCall.mock.calls.filter(
      ([args]) => args.method === 'status.get'
    )
    // One ownership probe per save plus the read client's one-time compatibility probe.
    expect(statusCalls).toHaveLength(4)
    expect(writeCalls()).toHaveLength(3)
  })

  it('refuses without writing when an older host holds newer disk content', async () => {
    serveHost({ enforcesPrecondition: false, diskContent: 'agent rewrite' })

    const result = await writeRuntimeFile(
      remoteContext,
      '/remote/repo/file.ts',
      'edited',
      undefined,
      precondition
    )

    expect(result).toEqual({ ok: false, diskConflict: 'changed' })
    expect(writeCalls()).toHaveLength(0)
  })

  it('reports a confirmed-missing file to an autosave through an older host', async () => {
    serveHost({ enforcesPrecondition: false })

    const result = await writeRuntimeFile(
      remoteContext,
      '/remote/repo/file.ts',
      'edited',
      undefined,
      precondition
    )

    expect(result).toEqual({ ok: false, diskConflict: 'missing' })
    expect(writeCalls()).toHaveLength(0)
  })

  it('lets an explicit save recreate a confirmed-missing file through an older host', async () => {
    serveHost({ enforcesPrecondition: false })
    runtimeEnvironmentCall.mockResolvedValue(rpcOk({ ok: true }))

    const result = await writeRuntimeFile(
      remoteContext,
      '/remote/repo/file.ts',
      'edited',
      undefined,
      {
        ...precondition,
        allowMissing: true
      }
    )

    expect(result).toEqual({ ok: true })
    expect(writeCalls()).toHaveLength(1)
  })

  it('fails an explicit save, without writing, when an older host read fails for another reason', async () => {
    serveHost({ enforcesPrecondition: false, readError: 'Runtime request timed out' })

    await expect(
      writeRuntimeFile(remoteContext, '/remote/repo/file.ts', 'edited', undefined, {
        ...precondition,
        allowMissing: true
      })
    ).rejects.toThrow('timed out')
    expect(writeCalls()).toHaveLength(0)
  })

  it('reports a file an older host can no longer send as changed', async () => {
    serveHost({
      enforcesPrecondition: false,
      readError: 'File too large: 60.0MB exceeds 50MB limit'
    })

    const result = await writeRuntimeFile(
      remoteContext,
      '/remote/repo/file.ts',
      'edited',
      undefined,
      {
        ...precondition,
        allowMissing: true
      }
    )

    expect(result).toEqual({ ok: false, diskConflict: 'changed' })
    expect(writeCalls()).toHaveLength(0)
  })

  it('binds a guarded write to the runtime whose capabilities were probed', async () => {
    serveHost({ enforcesPrecondition: true })
    runtimeEnvironmentCall.mockResolvedValue(rpcOk({ ok: true }))

    await writeRuntimeFile(remoteContext, '/remote/repo/file.ts', 'edited', undefined, precondition)

    expect(writeCalls()[0]).toMatchObject({ expectedEnvironmentRuntimeId: 'remote-runtime' })
  })

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

  it('reports the wire file_too_large refusal from an older host as changed', async () => {
    serveHost({
      enforcesPrecondition: false,
      readErrorCode: 'file_too_large',
      readError: 'file_too_large'
    })

    const result = await writeRuntimeFile(
      remoteContext,
      '/remote/repo/file.ts',
      'edited',
      undefined,
      {
        ...precondition,
        allowMissing: true
      }
    )

    expect(result).toEqual({ ok: false, diskConflict: 'changed' })
    expect(writeCalls()).toHaveLength(0)
  })

  it('keeps the save when the guarded write landed but its reply timed out', async () => {
    serveHost({ enforcesPrecondition: true, diskContent: 'edited' })
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc',
      ok: false,
      error: { code: 'runtime_timeout', message: 'Timed out waiting for the remote Orca runtime' },
      _meta: { runtimeId: 'remote-runtime' }
    })

    const result = await writeRuntimeFile(
      remoteContext,
      '/remote/repo/file.ts',
      'edited',
      undefined,
      precondition
    )

    expect(result).toEqual({ ok: true })
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

  it('still fails a timed-out guarded write whose content is not on disk', async () => {
    serveHost({ enforcesPrecondition: true, diskContent: 'original' })
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc',
      ok: false,
      error: { code: 'runtime_timeout', message: 'Timed out waiting for the remote Orca runtime' },
      _meta: { runtimeId: 'remote-runtime' }
    })

    await expect(
      writeRuntimeFile(remoteContext, '/remote/repo/file.ts', 'edited', undefined, precondition)
    ).rejects.toThrow('Timed out')
  })

  it('retries once on the new connection when it changed before the send', async () => {
    let probes = 0
    serveHost({
      enforcesPrecondition: true,
      onStatus: () => {
        probes += 1
        if (probes === 1) {
          // The save started while disconnected; the transport reconnects during the probe.
          advanceRuntimeEnvironmentConnectionGeneration('env-1')
        }
      }
    })
    runtimeEnvironmentCall.mockResolvedValue(rpcOk({ ok: true }))

    const result = await writeRuntimeFile(
      remoteContext,
      '/remote/repo/file.ts',
      'edited',
      undefined,
      precondition
    )

    expect(result).toEqual({ ok: true })
    expect(writeCalls()).toHaveLength(1)
  })

  it('re-probes once when the transport refused to send to a replacement runtime', async () => {
    let probes = 0
    serveHost({ enforcesPrecondition: true, onStatus: () => (probes += 1) })
    runtimeEnvironmentCall
      .mockResolvedValueOnce({
        id: 'files.writeIfUnchanged',
        ok: false,
        error: {
          code: 'runtime_environment_changed',
          message: 'Runtime environment identity changed; refresh and try again'
        },
        _meta: { runtimeId: 'remote-runtime' }
      })
      .mockResolvedValue(rpcOk({ ok: true }))

    const result = await writeRuntimeFile(
      remoteContext,
      '/remote/repo/file.ts',
      'edited',
      undefined,
      precondition
    )

    expect(result).toEqual({ ok: true })
    // The retry decides support from a fresh probe of whatever now answers.
    expect(probes).toBeGreaterThanOrEqual(2)
    expect(writeCalls()).toHaveLength(2)
  })

  it('never retries onto a host the environment was re-paired to mid-save', async () => {
    replaceRuntimeEnvironmentRevisions([{ id: 'env-1', createdAt: 1, pairingRevision: 1 }])
    serveHost({ enforcesPrecondition: true })
    runtimeEnvironmentCall.mockResolvedValue(rpcOk({ ok: true }))
    runtimeEnvironmentCall.mockImplementationOnce(async () => {
      // The user re-pairs the environment id to another machine while the first send is refused.
      replaceRuntimeEnvironmentRevisions([{ id: 'env-1', createdAt: 1, pairingRevision: 2 }])
      return {
        id: 'files.writeIfUnchanged',
        ok: false,
        error: {
          code: 'runtime_environment_changed',
          message: 'Runtime environment pairing changed; refresh and try again'
        },
        _meta: { runtimeId: 'remote-runtime' }
      }
    })

    await expect(
      writeRuntimeFile(remoteContext, '/remote/repo/file.ts', 'edited', undefined, precondition)
    ).rejects.toThrow('pairing changed')
    expect(writeCalls()).toHaveLength(1)
  })
})
