// JSON escaping can expand controls sixfold while NUL-only sniffing treats them as text; pin each budget branch to JSON.stringify.
import { describe, expect, it } from 'vitest'
import type { GitDiffResult } from './git-diff-compare-types'
import { REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES } from '../../remote-runtime/remote-runtime-memory-limits'
import {
  assertGitDiffWithinTransportBudget,
  gitDiffExceedsTransportBudget
} from './git-diff-transport-budget'
import {
  REMOTE_RPC_MAX_CONTENT_BYTES,
  remoteRpcContentBudget
} from '../../remote-rpc-content-budget'

const BUDGET = REMOTE_RPC_MAX_CONTENT_BYTES

function referenceResultBytes(result: GitDiffResult): number {
  return Buffer.byteLength(JSON.stringify(result), 'utf8')
}

/** Content whose JSON encoding, quotes included, is exactly `jsonBytes`. */
function sideOfJsonBytes(unit: string, jsonBytes: number): string {
  const unitCost = Buffer.byteLength(JSON.stringify(unit), 'utf8') - 2
  const count = Math.floor((jsonBytes - 2) / unitCost)
  return unit.repeat(count) + 'x'.repeat(jsonBytes - 2 - count * unitCost)
}

function textDiff(modifiedContent: string): GitDiffResult {
  return {
    kind: 'text',
    originalContent: '',
    modifiedContent,
    originalIsBinary: false,
    modifiedIsBinary: false
  }
}

function textDiffOfJsonBytes(unit: string, jsonBytes: number): GitDiffResult {
  const empty = textDiff('')
  const fixedBytes = referenceResultBytes(empty) - 2
  return textDiff(sideOfJsonBytes(unit, jsonBytes - fixedBytes))
}

function binaryDiffOfJsonBytes(unit: string, jsonBytes: number): GitDiffResult {
  const empty: GitDiffResult = {
    kind: 'binary',
    originalContent: '',
    modifiedContent: '',
    isImage: true,
    mimeType: 'image/png',
    originalIsBinary: true,
    modifiedIsBinary: true
  }
  const contentBytes = jsonBytes - (referenceResultBytes(empty) - 4)
  const firstBytes = Math.floor(contentBytes / 2)
  return {
    ...empty,
    originalContent: sideOfJsonBytes(unit, firstBytes),
    modifiedContent: sideOfJsonBytes(unit, contentBytes - firstBytes)
  }
}

function budgetError(result: GitDiffResult): { code?: string; data?: unknown } {
  try {
    assertGitDiffWithinTransportBudget(result, BUDGET)
  } catch (error) {
    return error as { code?: string; data?: unknown }
  }
  throw new Error('expected the transport budget assertion to throw')
}

describe('gitDiffExceedsTransportBudget', () => {
  // Why: this is the case a raw-byte budget silently lets through into the 1013 close.
  it('rejects control-dense content whose raw bytes are far under the budget', () => {
    const result = textDiffOfJsonBytes('\u0001', BUDGET + 1)

    expect(Buffer.byteLength(result.modifiedContent, 'utf8')).toBeLessThan(BUDGET / 5)
    expect(budgetError(result).data).toEqual({ maxBytes: BUDGET })
  })

  it('splits the budget across both sides', () => {
    const overBudget = binaryDiffOfJsonBytes('Q', BUDGET + 1)

    expect(referenceResultBytes(overBudget)).toBe(BUDGET + 1)
    expect(budgetError(overBudget).code).toBe('diff_too_large')
  })

  it('rejects additive relay metadata beyond the result budget', () => {
    const skewed = {
      ...textDiff(''),
      futureMetadata: 'x'.repeat(BUDGET)
    } as unknown as GitDiffResult

    expect(gitDiffExceedsTransportBudget(skewed, BUDGET)).toBe(true)
    expect(budgetError(skewed).code).toBe('diff_too_large')
  })
})

// Why: the invariant the cap rests on — a diff that exactly fills the content budget must still
// serialize inside the outbound JSON limit once wrapped in an RPC reply. A base64-only version of
// this passes trivially; the newline and control-char fixtures are the load-bearing ones.
describe('envelope ceiling', () => {
  function replyBytes(result: GitDiffResult, requestId = 'req_0123456789abcdef'): number {
    return Buffer.byteLength(
      JSON.stringify({
        id: requestId,
        ok: true,
        result,
        _meta: { runtimeId: '00000000-0000-4000-8000-000000000000' }
      }),
      'utf8'
    )
  }

  it('charges an escape-dense request id instead of overflowing the fixed reserve', () => {
    const requestId = '\u0001'.repeat(8_192)
    const budget = remoteRpcContentBudget(requestId)

    expect(budget).toBeLessThan(BUDGET)
    expect(replyBytes(binaryDiffOfJsonBytes('a', budget), requestId)).toBeLessThanOrEqual(
      REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES
    )
  })
})
