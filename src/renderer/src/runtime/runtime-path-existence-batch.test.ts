import { expect, it } from 'vitest'
import { runtimePathsExist } from '@/runtime/runtime-path-existence-batch'
import {
  installRuntimeFileClientEnvironment,
  runtimeEnvironmentCall,
  runtimeEnvironmentTransportCall,
  fsPathExists
} from '@/runtime/runtime-file-client-test-harness'
import {
  RUNTIME_PROTOCOL_VERSION,
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
} from '../../../shared/protocol-version'
installRuntimeFileClientEnvironment()
const context = {
  settings: { activeRuntimeEnvironmentId: 'owner-a' },
  worktreeId: 'folder-1',
  worktreePath: '/folder'
}
const paths = Array.from({ length: 8 }, (_, i) => `/folder/file-${i}.ts`)
function status(capabilities: string[]) {
  runtimeEnvironmentTransportCall.mockImplementation(async (args) =>
    args.method === 'status.get'
      ? {
          id: 'status',
          ok: true,
          result: {
            runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
            minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
            capabilities
          },
          _meta: { runtimeId: 'owner-runtime' }
        }
      : runtimeEnvironmentCall(args)
  )
}
it('paired runtime receives one eight-path request scoped to the folder workspace', async () => {
  status(['files.pathsExist'])
  runtimeEnvironmentCall.mockResolvedValue({
    id: 'batch',
    ok: true,
    result: paths.map(() => ({ exists: true }))
  })
  expect(await runtimePathsExist(context, paths)).toEqual(paths.map(() => ({ exists: true })))
  expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(1)
  expect(runtimeEnvironmentCall.mock.calls[0][0]).toMatchObject({
    selector: 'owner-a',
    method: 'files.pathsExist',
    params: { worktree: 'id:folder-1', relativePaths: paths.map((p) => p.slice('/folder/'.length)) }
  })
  expect(fsPathExists).not.toHaveBeenCalled()
})
it('old paired host retains scalar stats on that runtime and does not call the new method', async () => {
  status([])
  runtimeEnvironmentCall.mockResolvedValue({ id: 'stat', ok: true, result: { size: 1 } })
  expect(await runtimePathsExist(context, paths)).toEqual(paths.map(() => ({ exists: true })))
  expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(8)
  expect(
    runtimeEnvironmentCall.mock.calls.every(
      ([args]) => args.method === 'files.stat' && args.selector === 'owner-a'
    )
  ).toBe(true)
  expect(fsPathExists).not.toHaveBeenCalled()
})
it('new method missing after capability discovery falls back only for method_not_found', async () => {
  status(['files.pathsExist'])
  runtimeEnvironmentCall.mockImplementation(async (args) =>
    args.method === 'files.pathsExist'
      ? { id: 'batch', ok: false, error: { code: 'method_not_found', message: 'Unknown method' } }
      : { id: 'stat', ok: true, result: { size: 1 } }
  )
  expect(await runtimePathsExist(context, paths)).toEqual(paths.map(() => ({ exists: true })))
  expect(
    runtimeEnvironmentCall.mock.calls.filter(([args]) => args.method === 'files.stat')
  ).toHaveLength(8)
})
it('remote errors stay errors, and an out-of-scope path cannot read the local filesystem', async () => {
  status(['files.pathsExist'])
  runtimeEnvironmentCall.mockResolvedValue({
    id: 'batch',
    ok: true,
    result: [{ error: 'SSH connection closed' }]
  })
  expect(await runtimePathsExist(context, [paths[0]])).toEqual([{ error: 'SSH connection closed' }])
  expect(await runtimePathsExist(context, ['/outside/file.ts'])).toEqual([
    { error: expect.stringContaining('outside') }
  ])
  expect(fsPathExists).not.toHaveBeenCalled()
})
