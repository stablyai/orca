import {
  parsePtyOwnershipTransferPreflightResult,
  type PtyOwnershipTransferPreflightResult
} from '../../../shared/pty-ownership-transfer-orchestration'
import type { PtyOwnershipTransferIdentity } from '../../../shared/pty-ownership-transfer-journal-contract'
import { PTY_OWNERSHIP_TRANSFER_RUNTIME_METHODS } from '../../../shared/pty-ownership-transfer-runtime-methods'
import type { PtyOwnershipTransferStatusResult } from '../../../shared/pty-ownership-transfer-wire'
import { parsePtyOwnershipTransferStatusResult } from '../../../shared/pty-ownership-transfer-wire-results'
import { parseRemoteRuntimePtyId } from '../../../shared/remote-runtime-pty-id'
import { callRuntimeRpc, hasRuntimeRpcErrorCode } from './runtime-rpc-client'

type RequestOptions = Readonly<{ timeoutMs?: number; signal?: AbortSignal }>

type PairedRuntimePtyOwnershipTransferClientDependencies = Readonly<{
  callRuntimeRpc: typeof callRuntimeRpc
}>

/** Strict read-only transport to the paired runtime that owns a scoped PTY handle. */
export class PairedRuntimePtyOwnershipTransferClient {
  private readonly environmentId: string
  private readonly terminalId: string

  constructor(
    ptyId: string,
    private readonly destinationRuntimeId: string,
    private readonly dependencies: PairedRuntimePtyOwnershipTransferClientDependencies = {
      callRuntimeRpc
    }
  ) {
    if (
      typeof ptyId !== 'string' ||
      typeof destinationRuntimeId !== 'string' ||
      !destinationRuntimeId.trim()
    ) {
      throw invalidSourceIdentity()
    }
    const source = parseRemoteRuntimePtyId(ptyId)
    if (!source?.environmentId || !source.handle) {
      throw invalidSourceIdentity()
    }
    this.environmentId = source.environmentId
    this.terminalId = source.handle
  }

  async preflight(options: RequestOptions = {}): Promise<PtyOwnershipTransferPreflightResult> {
    try {
      const response = await this.request(
        PTY_OWNERSHIP_TRANSFER_RUNTIME_METHODS.preflightSource,
        {
          ptyId: this.terminalId,
          destinationRuntimeId: this.destinationRuntimeId
        },
        options
      )
      const parsed = parsePtyOwnershipTransferPreflightResult(response)
      if (parsed.topology !== 'runtime-owned') {
        throw new Error('pty_ownership_transfer_preflight_topology_mismatch')
      }
      return Object.freeze({ ...parsed, topology: 'paired-runtime-reference' })
    } catch (error) {
      if (!isPtyOwnershipTransferMethodNotFoundError(error)) {
        throw error
      }
      return unavailablePreflight()
    }
  }

  async status(
    identity: PtyOwnershipTransferIdentity,
    options: RequestOptions = {}
  ): Promise<PtyOwnershipTransferStatusResult | null> {
    if (
      identity.terminalId !== this.terminalId ||
      identity.destinationRuntimeId !== this.destinationRuntimeId
    ) {
      throw invalidSourceIdentity()
    }
    try {
      const response = await this.request(
        PTY_OWNERSHIP_TRANSFER_RUNTIME_METHODS.statusSource,
        {
          ptyId: this.terminalId,
          destinationRuntimeId: this.destinationRuntimeId,
          identity,
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs })
        },
        options
      )
      const parsed = parsePtyOwnershipTransferStatusResult(response)
      assertStatusIdentity(parsed, identity)
      return parsed
    } catch (error) {
      if (isPtyOwnershipTransferMethodNotFoundError(error)) {
        return null
      }
      throw error
    }
  }

  private request(method: string, params: unknown, options: RequestOptions): Promise<unknown> {
    return this.dependencies.callRuntimeRpc<unknown>(
      { kind: 'environment', environmentId: this.environmentId },
      method,
      params,
      { timeoutMs: options.timeoutMs ?? 5_000, signal: options.signal }
    )
  }
}

export function isPtyOwnershipTransferMethodNotFoundError(error: unknown): boolean {
  if (hasRuntimeRpcErrorCode(error, 'method_not_found')) {
    return true
  }
  if (!error || typeof error !== 'object' || !('message' in error)) {
    return false
  }
  const message = (error as { message?: unknown }).message
  return typeof message === 'string' && /(?:^|: )unknown method(?:: .+)?$/i.test(message.trim())
}

function assertStatusIdentity(
  response: PtyOwnershipTransferStatusResult,
  expected: PtyOwnershipTransferIdentity
): void {
  if (
    response.bridgeId !== expected.bridgeId ||
    response.terminalId !== expected.terminalId ||
    response.incarnationId !== expected.incarnationId ||
    response.ownerLease !== expected.ownerLease ||
    response.sourceOwnerGeneration !== expected.sourceOwnerGeneration ||
    response.destinationRuntimeId !== expected.destinationRuntimeId
  ) {
    throw new Error('pty_ownership_transfer_response_identity_mismatch')
  }
}

function unavailablePreflight(): PtyOwnershipTransferPreflightResult {
  return Object.freeze({
    topology: 'paired-runtime-reference',
    transferSupported: false,
    statusQuerySupported: false,
    blocker: 'source-capabilities-unavailable',
    capabilities: null
  })
}

function invalidSourceIdentity(): Error {
  return new Error('pty_ownership_transfer_paired_source_identity_invalid')
}
