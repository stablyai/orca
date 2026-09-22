// The only positions in a journal row where Orca itself records the digest of a
// retained payload.
//
// Ownership of a retained payload is decided by these positions and by nothing
// else. A session authors tool-call `input` and block bodies freely, so a
// digest found there says only that the session typed 64 hex characters — it
// proves nothing about what the session retained. Because the payload store is
// process-wide and content-addressed, accepting such a digest as ownership
// turns it into a cross-session oracle. Every writer that mints a reference
// (journal-payload-bounds, the legacy import, the worker transcript
// projection) writes one of the two shapes below, in one of the fields walked
// here, and a reader admits a digest only from those.

/** Lowercase sha256, the only digest form a reference may carry. */
const PAYLOAD_DIGEST_PATTERN = /^[0-9a-f]{64}$/

/** `AgentJournalBoundedPayload` as journal-payload-bounds writes it: the head
 *  that stayed on the row plus the identity of the original it replaced. */
function boundedPayloadReferenceDigest(value: unknown): string | null {
  const record = asRecord(value)
  if (
    !record ||
    typeof record['head'] !== 'string' ||
    typeof record['byteLength'] !== 'number' ||
    typeof record['truncated'] !== 'boolean'
  ) {
    return null
  }
  return asDigest(record['digest'])
}

/** `NativeChatClippedPayload` as the legacy import and the worker transcript
 *  projection write it: the reference alone, beside the block it clipped. */
function clippedPayloadReferenceDigest(value: unknown): string | null {
  const record = asRecord(value)
  if (
    !record ||
    typeof record['byteLength'] !== 'number' ||
    typeof record['retrievable'] !== 'boolean'
  ) {
    return null
  }
  return asDigest(record['digest'])
}

/**
 * Every payload digest a parsed journal row genuinely references. Model-authored
 * subtrees are deliberately not walked, so a digest a session merely echoed back
 * into its own tool input never appears here.
 */
export function collectJournalRowPayloadDigests(row: unknown): Set<string> {
  const digests = new Set<string>()
  const record = asRecord(row)
  if (record) {
    // Item and submission rows both carry the render body under `body`.
    collectBodyDigests(record['body'], digests)
    // A lifecycle-batch row nests its bodies one level down, so a settled
    // tool-call carried in a batch references its output from there.
    const mutations = record['mutations']
    if (Array.isArray(mutations)) {
      for (const mutation of mutations) {
        collectBodyDigests(asRecord(mutation)?.['body'], digests)
      }
    }
  }
  return digests
}

/** True when `row` names `digest` in one of its own reference fields. */
export function journalRowReferencesDigest(row: unknown, digest: string): boolean {
  return collectJournalRowPayloadDigests(row).has(digest)
}

/** The reference fields of one render body: a message's blocks, a tool call's
 *  `output`, a diff's `patch`. A tool call's `input` is never walked. */
function collectBodyDigests(body: unknown, into: Set<string>): void {
  const record = asRecord(body)
  if (!record) {
    return
  }
  if (record['kind'] === 'message') {
    const blocks = record['blocks']
    if (Array.isArray(blocks)) {
      for (const block of blocks) {
        collectBlockDigests(block, into)
      }
    }
    return
  }
  if (record['kind'] === 'tool-call') {
    add(into, boundedPayloadReferenceDigest(record['output']))
    return
  }
  if (record['kind'] === 'diff') {
    add(into, boundedPayloadReferenceDigest(record['patch']))
    return
  }
  if (record['kind'] === 'status') {
    // unhandled-provider-frame.ts writes its bounded original here, on the status body.
    add(into, boundedPayloadReferenceDigest(asRecord(record['providerFrame'])?.['payload']))
  }
}

/** The reference fields of one content block. Only `text` and `tool-result`
 *  blocks carry a reference Orca wrote; every other block type is the model's. */
function collectBlockDigests(block: unknown, into: Set<string>): void {
  const record = asRecord(block)
  const type = record?.['type']
  // A tool-call block's `input` is the model's own JSON and is never a reference.
  if (!record || (type !== 'text' && type !== 'tool-result')) {
    return
  }
  add(into, clippedPayloadReferenceDigest(record['clipped']))
  if (type === 'text') {
    const frame = asRecord(record['providerFrame'])
    if (frame) {
      add(into, boundedPayloadReferenceDigest(frame['payload']))
    }
  }
}

/** Adds a recognised digest, dropping the null a failed shape check returns. */
function add(into: Set<string>, digest: string | null): void {
  if (digest !== null) {
    into.add(digest)
  }
}

/** The value only when it is a lowercase sha256; anything else references nothing. */
function asDigest(value: unknown): string | null {
  return typeof value === 'string' && PAYLOAD_DIGEST_PATTERN.test(value) ? value : null
}

/** A plain object to read fields off, or null for anything not indexable. */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a non-null, non-array object is indexable by string; every read below re-narrows.
  return value as Record<string, unknown>
}
