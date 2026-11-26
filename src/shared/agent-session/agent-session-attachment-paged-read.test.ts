import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import type { AttachmentTextRequest } from '../attachment-text/attachment-text-source'
import { readAttachmentBase64InRanges } from './agent-session-attachment-paged-read'

// The host's readTextChunk contract: one snapshot per file version, a refusal on a stale one.
function host(versions: Buffer[], enforceSnapshot = true) {
  const requests: AttachmentTextRequest[] = []
  const snapshot = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
  return {
    requests,
    read: async (request: AttachmentTextRequest) => {
      requests.push(request)
      const bytes = versions[Math.min(requests.length - 1, versions.length - 1)]!
      if (
        enforceSnapshot &&
        request.expectedSnapshot &&
        request.expectedSnapshot !== snapshot(bytes)
      ) {
        throw new Error('Attachment changed. Close it and try again.')
      }
      const chunk = bytes.subarray(request.offset, request.offset + request.length)
      return {
        snapshot: snapshot(bytes),
        size: bytes.length,
        contentBase64: chunk.toString('base64'),
        bytesRead: chunk.length,
        eof: request.offset + chunk.length === bytes.length
      }
    }
  }
}

it('joins ranges into the exact file, pinned to the first snapshot', async () => {
  const bytes = Buffer.from(Array.from({ length: 700_001 }, (_, index) => (index * 7) % 256))
  const { read, requests } = host([bytes])
  const base64 = await readAttachmentBase64InRanges(read, '/store/id/big.png', 1_000_000)
  expect(Buffer.from(base64!, 'base64').equals(bytes)).toBe(true)
  expect(requests.length).toBeGreaterThan(1)
  expect(requests[0]!.length).toBe(1)
  expect(requests[1]!.expectedSnapshot).toMatch(/^[a-f0-9]{64}$/)
  expect(
    requests.slice(1).every((request) => request.expectedSnapshot === requests[1]!.expectedSnapshot)
  ).toBe(true)
})

it('stops at the cap and refuses a file that changes mid-read', async () => {
  const bytes = Buffer.alloc(600_000, 1)
  expect(await readAttachmentBase64InRanges(host([bytes]).read, '/p.png', 599_999)).toBeNull()
  // A host that skips its own check still cannot splice two versions.
  const changed = host([bytes, Buffer.alloc(600_000, 2)], false)
  await expect(readAttachmentBase64InRanges(changed.read, '/p.png', 1_000_000)).rejects.toThrow()
})
