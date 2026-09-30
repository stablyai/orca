import { vi } from 'vitest'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../../shared/protocol-version'
import { preparePendingSplitClose } from './pending-split-close-test-fixture'
import { flushPtySideEffects } from './pty-transport-test-harness'

export async function preparePendingRuntimeClose(id = 'remote:env-1@@term_original') {
  const p = await preparePendingSplitClose(id)
  p.transport.detach?.({ preserveExitObserver: false })
  p.spawn.resolve({ id, isReattach: true })
  await p.connecting
  p.state.worktreesByRepo = {
    repo: [{ id: 'workspace', repoId: 'repo', runtimeOwnerEnvironmentId: 'env-1' }]
  }
  const resolvePane = Promise.withResolvers<unknown>()
  const compatibility = Promise.withResolvers<unknown>()
  const runtimeCall = vi.fn(
    (request: {
      method: string
      params?: unknown
      expectedEnvironmentPairingRevision?: number
    }): Promise<unknown> => {
      if (request.method === 'terminal.resolvePane') {
        return resolvePane.promise
      }
      if (request.method === 'status.get') {
        return compatibility.promise
      }
      return Promise.resolve({ ok: true, result: {} })
    }
  )
  Object.assign(window.api, { runtimeEnvironments: { call: runtimeCall } })
  const { replaceRuntimeEnvironmentRevisions } =
    await import('../../runtime/runtime-environment-revision')
  replaceRuntimeEnvironmentRevisions([{ id: 'env-1', createdAt: 1, pairingRevision: 1 }])
  const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
  const remote = createRemoteRuntimePtyTransport('env-1', {
    worktreeId: 'workspace',
    tabId: p.tabId,
    leafId: p.leafId
  })
  p.transports.set(1, remote)
  remote.attach({ existingPtyId: id, callbacks: {} })
  const acceptCompatibility = (): void =>
    compatibility.resolve({
      ok: true,
      result: {
        runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
        minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
      }
    })
  return {
    ...p,
    remote,
    runtimeCall,
    compatibility,
    acceptCompatibility,
    replaceRuntimeEnvironmentRevisions,
    async settle(handle = 'term_original') {
      resolvePane.resolve({
        ok: true,
        result: {
          terminal: {
            handle,
            tabId: p.tabId,
            leafId: p.leafId,
            worktreeId: 'workspace',
            ptyId: 'host-pty'
          }
        }
      })
      await flushPtySideEffects()
      remote.destroy?.()
    }
  }
}
