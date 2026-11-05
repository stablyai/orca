import {
  RANGED_FILE_DOCUMENT_CAPABILITY,
  RANGED_FILE_DOCUMENT_METHODS
} from '../../../shared/ranged-file-document'
import type { RuntimeFileReadArgs } from './runtime-file-client-types'
import { rangeReadTarget } from './runtime-file-range-client'
import { pinRemoteFileAddress } from './runtime-paged-file-read'
import { assertRuntimeEnvironmentCapability, callRuntimeRpc } from './runtime-rpc-client'
import {
  onRuntimeEnvironmentsRetired,
  onRuntimeEnvironmentRevisionsChanged
} from './runtime-environment-revision'
import { RuntimeRangeDocument, type RangeDocumentTransport } from './runtime-range-document'

/** One authorized source, pinned to its owning runtime pairing for its whole lifetime. */
export async function openRuntimeRangeDocument(
  args: RuntimeFileReadArgs,
  assertReadable?: () => void
): Promise<RuntimeRangeDocument> {
  assertReadable?.()
  if (args.terminalArtifactGrantId) {
    throw new Error('Ranged documents do not support artifact grants.')
  }
  const address = rangeReadTarget(args)
  const remote = address ? pinRemoteFileAddress(address) : null
  if (remote) {
    await assertRuntimeEnvironmentCapability(
      remote.target.environmentId,
      RANGED_FILE_DOCUMENT_CAPABILITY,
      'Ranged binary documents require an updated Orca server.'
    )
  }
  const remoteCall = <T>(
    method: keyof typeof RANGED_FILE_DOCUMENT_METHODS,
    params: unknown,
    signal?: AbortSignal
  ): Promise<T> => {
    if (!remote) {
      throw new Error('Missing owning runtime.')
    }
    return callRuntimeRpc<T>(remote.target, RANGED_FILE_DOCUMENT_METHODS[method], params, {
      signal,
      expectedEnvironmentPairingRevision: remote.expectedEnvironmentPairingRevision
    })
  }
  const fs = window.api.fs
  const transport: RangeDocumentTransport = remote
    ? {
        open: () =>
          remoteCall('open', { worktree: remote.worktree, relativePath: remote.relativePath }),
        read: (params, signal) => remoteCall('read', params, signal),
        reload: (params) => remoteCall('reload', params),
        status: (params) => remoteCall('status', params),
        close: (params) => remoteCall('close', params),
        cancel: (params) => remoteCall('cancel', params)
      }
    : {
        open: () =>
          fs.rangeDocumentOpen({
            filePath: args.filePath,
            access: args.access,
            connectionId: args.connectionId,
            wakeWslDistro: args.wakeWslDistro
          }),
        read: (params) => fs.rangeDocumentRead(params),
        reload: (params) => fs.rangeDocumentReload(params),
        status: (params) => fs.rangeDocumentStatus(params),
        close: (params) => fs.rangeDocumentClose(params),
        cancel: (params) => fs.rangeDocumentCancel(params)
      }
  const descriptor = await transport.open()
  try {
    assertReadable?.()
  } catch (error) {
    await transport.close({ id: descriptor.id }).catch(() => {})
    throw error
  }
  const document = new RuntimeRangeDocument(descriptor, transport, assertReadable)
  if (remote) {
    const retired = onRuntimeEnvironmentsRetired((ids) => {
      if (ids.includes(remote.target.environmentId)) {
        document.invalidate()
        document.close()
      }
    })
    const replaced = onRuntimeEnvironmentRevisionsChanged((ids) => {
      if (ids.includes(remote.target.environmentId)) {
        document.invalidate()
        document.close()
      }
    })
    document.onDispose = () => {
      retired()
      replaced()
    }
  }
  return document
}
