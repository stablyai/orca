import { describe, expect, it } from 'vitest'
import {
  base64PayloadByteLength,
  describeOdooAttachmentUploadOverLimit,
  ODOO_ATTACHMENT_UPLOAD_MAX_BYTES,
  sumOdooAttachmentUploadBytes
} from './odoo-attachment-upload-limit'

describe('base64PayloadByteLength', () => {
  it('computes the decoded byte length, accounting for padding', () => {
    // 'AAAA' decodes to 3 bytes, no padding.
    expect(base64PayloadByteLength('AAAA')).toBe(3)
    // 'AA==' decodes to 1 byte (2 padding chars).
    expect(base64PayloadByteLength('AA==')).toBe(1)
    // 'AAA=' decodes to 2 bytes (1 padding char).
    expect(base64PayloadByteLength('AAA=')).toBe(2)
  })

  it('returns 0 for empty input', () => {
    expect(base64PayloadByteLength('')).toBe(0)
  })
})

describe('sumOdooAttachmentUploadBytes', () => {
  it('sums the decoded size across files', () => {
    expect(sumOdooAttachmentUploadBytes([{ data: 'AAAA' }, { data: 'AAAA' }])).toBe(6)
  })
})

describe('describeOdooAttachmentUploadOverLimit', () => {
  it('returns null when the total is within the cap', () => {
    expect(describeOdooAttachmentUploadOverLimit([{ data: 'AAAA' }], 1024)).toBeNull()
  })

  it('returns an explanatory error when the total exceeds the cap', () => {
    const oneMebibyteOfBase64Chars = 'A'.repeat(Math.ceil((1.5 * 1024 * 1024 * 4) / 3))
    const error = describeOdooAttachmentUploadOverLimit(
      [{ data: oneMebibyteOfBase64Chars }],
      1024 * 1024
    )
    expect(error).toContain('exceeding the 1.0 MB upload limit')
  })

  it('exposes the default cap for callers that want to reference it', () => {
    expect(ODOO_ATTACHMENT_UPLOAD_MAX_BYTES).toBeGreaterThan(0)
  })
})
