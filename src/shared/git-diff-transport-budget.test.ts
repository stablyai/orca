// Why: a raw-byte cap is not enough. JSON escaping expands a control character sixfold and
// binary-buffer.ts sniffs only for NUL, so control-dense content is classified as text; these
// fixtures pin every branch of the measurement to native JSON.stringify.
import { describe, expect, it, vi } from 'vitest'
import type { GitDiffResult } from './types'
import { REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES } from './remote-runtime-memory-limits'
import {
  REMOTE_RPC_MAX_CONTENT_BYTES,
  assertGitDiffWithinTransportBudget,
  gitDiffExceedsTransportBudget
} from './git-diff-transport-budget'

const BUDGET = REMOTE_RPC_MAX_CONTENT_BYTES

/** Native reference: the bytes the two content sides occupy once JSON-encoded. */
function referenceContentBytes(result: GitDiffResult): number {
  return (
    Buffer.byteLength(JSON.stringify(result.originalContent), 'utf8') +
    Buffer.byteLength(JSON.stringify(result.modifiedContent), 'utf8')
  )
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

function budgetError(result: GitDiffResult): { code?: string; data?: unknown } {
  try {
    assertGitDiffWithinTransportBudget(result, BUDGET)
  } catch (error) {
    return error as { code?: string; data?: unknown }
  }
  throw new Error('expected the transport budget assertion to throw')
}

const UNITS: readonly { name: string; unit: string; expansion: number }[] = [
  { name: 'ascii', unit: 'a', expansion: 1 },
  { name: 'newline-dense text', unit: '\n', expansion: 2 },
  { name: 'control-char text (0x01)', unit: '\u0001', expansion: 6 },
  { name: 'base64', unit: 'QUJD', expansion: 1 },
  { name: 'cjk', unit: '漢', expansion: 1 },
  { name: 'lone surrogate', unit: '\ud800', expansion: 2 },
  { name: 'surrogate pair', unit: '😀', expansion: 1 },
  { name: 'quotes and backslashes', unit: '"\\', expansion: 2 }
]

describe('gitDiffExceedsTransportBudget', () => {
  it.each(UNITS)('pins the JSON expansion assumed for $name', ({ unit, expansion }) => {
    const jsonBytes = Buffer.byteLength(JSON.stringify(unit), 'utf8') - 2
    expect(jsonBytes / Buffer.byteLength(unit, 'utf8')).toBe(expansion)
  })

  it.each(UNITS)('admits $name exactly at the budget', ({ unit }) => {
    const result = textDiff(sideOfJsonBytes(unit, BUDGET - 2))

    expect(referenceContentBytes(result)).toBe(BUDGET)
    expect(gitDiffExceedsTransportBudget(result, BUDGET)).toBe(false)
    expect(assertGitDiffWithinTransportBudget(result, BUDGET)).toBe(result)
  })

  it.each(UNITS)('rejects $name one byte above the budget', ({ unit }) => {
    const result = textDiff(sideOfJsonBytes(unit, BUDGET - 1))

    expect(referenceContentBytes(result)).toBe(BUDGET + 1)
    expect(gitDiffExceedsTransportBudget(result, BUDGET)).toBe(true)
    expect(budgetError(result).code).toBe('diff_too_large')
  })

  it.each(UNITS)('agrees with native JSON.stringify across the boundary for $name', ({ unit }) => {
    for (const jsonBytes of [BUDGET - 3, BUDGET - 2, BUDGET - 1]) {
      const result = textDiff(sideOfJsonBytes(unit, jsonBytes))
      expect(gitDiffExceedsTransportBudget(result, BUDGET)).toBe(
        referenceContentBytes(result) > BUDGET
      )
    }
  })

  // Why: this is the case a raw-byte budget silently lets through into the 1013 close.
  it('rejects control-dense content whose raw bytes are far under the budget', () => {
    const result = textDiff(sideOfJsonBytes('\u0001', BUDGET - 1))

    expect(Buffer.byteLength(result.modifiedContent, 'utf8')).toBeLessThan(BUDGET / 5)
    expect(budgetError(result).data).toEqual({ maxBytes: BUDGET })
  })

  it('splits the budget across both sides', () => {
    const half = Math.floor(BUDGET / 2)
    const overBudget: GitDiffResult = {
      kind: 'binary',
      originalContent: sideOfJsonBytes('Q', half),
      modifiedContent: sideOfJsonBytes('Q', BUDGET - half + 1),
      originalIsBinary: true,
      modifiedIsBinary: true
    }

    expect(referenceContentBytes(overBudget)).toBe(BUDGET + 1)
    expect(budgetError(overBudget).code).toBe('diff_too_large')
  })

  it('admits small content without an escape-aware scan', () => {
    const charCodeAt = vi.spyOn(String.prototype, 'charCodeAt')
    try {
      expect(gitDiffExceedsTransportBudget(textDiff('hello'), BUDGET)).toBe(false)
      expect(charCodeAt).not.toHaveBeenCalled()
    } finally {
      charCodeAt.mockRestore()
    }
  })

  // Why: the SSH provider casts a relay payload to GitDiffResult without validating it.
  it('treats a side missing from a relay payload as empty', () => {
    const skewed = { kind: 'text', modifiedContent: 'hi' } as unknown as GitDiffResult

    expect(gitDiffExceedsTransportBudget(skewed, BUDGET)).toBe(false)
    expect(assertGitDiffWithinTransportBudget(skewed, BUDGET)).toBe(skewed)
  })

  it('leaves local callers uncapped', () => {
    const result = textDiff('x'.repeat(BUDGET + 1))

    expect(assertGitDiffWithinTransportBudget(result, undefined)).toBe(result)
  })
})

// Why: the invariant the cap rests on — a diff that exactly fills the content budget must still
// serialize inside the outbound JSON limit once wrapped in an RPC reply. A base64-only version of
// this passes trivially; the newline and control-char fixtures are the load-bearing ones.
describe('envelope ceiling', () => {
  function replyBytes(result: GitDiffResult): number {
    return Buffer.byteLength(
      JSON.stringify({
        id: 'req_0123456789abcdef',
        ok: true,
        result,
        _meta: { runtimeId: '00000000-0000-4000-8000-000000000000' }
      }),
      'utf8'
    )
  }

  function diffAtBudget(unit: string): GitDiffResult {
    return {
      kind: 'binary',
      originalContent: sideOfJsonBytes(unit, Math.floor(BUDGET / 2)),
      modifiedContent: sideOfJsonBytes(unit, BUDGET - Math.floor(BUDGET / 2)),
      isImage: true,
      mimeType: 'image/png',
      originalIsBinary: true,
      modifiedIsBinary: true
    }
  }

  it.each(UNITS)('keeps a $name diff at the budget inside the outbound limit', ({ unit }) => {
    expect(replyBytes(diffAtBudget(unit))).toBeLessThanOrEqual(
      REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES
    )
  })

  // Why: every reserved byte is content that transferred before this cap existed, so the reserve
  // must stay close to the real envelope overhead. Fails if someone inflates it "just to be safe".
  it('keeps the envelope reserve within 64x the overhead it covers', () => {
    const overhead = replyBytes(diffAtBudget('a')) - BUDGET
    const reserve = REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES - BUDGET

    expect(reserve).toBeGreaterThan(overhead)
    expect(reserve).toBeLessThan(overhead * 64)
  })
})
