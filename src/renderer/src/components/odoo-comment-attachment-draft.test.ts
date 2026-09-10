// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'

import {
  MAX_ODOO_ATTACHMENT_BYTES,
  MAX_ODOO_ATTACHMENT_COUNT,
  formatOdooAttachmentSize,
  odooAttachmentDraftSetKey,
  readOdooAttachmentAsBase64,
  stripBase64DataUrlPrefix,
  validateOdooAttachmentSelection
} from './odoo-comment-attachment-draft'

function file(name: string, size = 4): File {
  const blob = new File(['x'.repeat(Math.max(size, 1))], name, { type: 'text/plain' })
  Object.defineProperty(blob, 'size', { value: size })
  return blob
}

describe('validateOdooAttachmentSelection', () => {
  it('accepts well-formed files with distinct ids', () => {
    const { accepted, errors } = validateOdooAttachmentSelection([file('a.txt'), file('b.txt')], 0)
    expect(errors).toEqual([])
    expect(accepted).toHaveLength(2)
    expect(new Set(accepted.map((draft) => draft.id)).size).toBe(2)
    expect(accepted[0]).toMatchObject({ name: 'a.txt', mimetype: 'text/plain', size: 4 })
  })

  it('rejects an empty file instead of silently skipping it', () => {
    const { accepted, errors } = validateOdooAttachmentSelection([file('empty.txt', 0)], 0)
    expect(accepted).toEqual([])
    expect(errors).toEqual(['empty.txt is empty.'])
  })

  it('rejects a file larger than the cap', () => {
    const { accepted, errors } = validateOdooAttachmentSelection(
      [file('huge.bin', MAX_ODOO_ATTACHMENT_BYTES + 1)],
      0
    )
    expect(accepted).toEqual([])
    expect(errors).toEqual(['huge.bin would exceed the 15.0 MB attachment limit.'])
  })

  it('rejects a file that would push the cumulative total over the cap', () => {
    const { accepted, errors } = validateOdooAttachmentSelection(
      [file('one-more.bin', 1024)],
      0,
      MAX_ODOO_ATTACHMENT_BYTES - 100
    )
    expect(accepted).toEqual([])
    expect(errors).toEqual(['one-more.bin would exceed the 15.0 MB attachment limit.'])
  })

  it('stops accepting once the existing count reaches the cap', () => {
    const { accepted, errors } = validateOdooAttachmentSelection(
      [file('one-more.txt')],
      MAX_ODOO_ATTACHMENT_COUNT
    )
    expect(accepted).toEqual([])
    expect(errors).toEqual([`You can attach up to ${MAX_ODOO_ATTACHMENT_COUNT} files.`])
  })

  it('falls back to a generic mimetype when the browser reports none', () => {
    const blob = new File(['x'], 'noext', { type: '' })
    const { accepted } = validateOdooAttachmentSelection([blob], 0)
    expect(accepted[0].mimetype).toBe('application/octet-stream')
  })
})

describe('odooAttachmentDraftSetKey', () => {
  it('is stable for the same staged set, so a retry can reuse its upload', () => {
    const { accepted } = validateOdooAttachmentSelection([file('a.txt'), file('b.txt')], 0)
    expect(odooAttachmentDraftSetKey(accepted)).toBe(odooAttachmentDraftSetKey([...accepted]))
  })

  it('changes when a draft is removed, so the retry re-uploads what is left', () => {
    const { accepted } = validateOdooAttachmentSelection([file('a.txt'), file('b.txt')], 0)
    expect(odooAttachmentDraftSetKey(accepted.slice(1))).not.toBe(
      odooAttachmentDraftSetKey(accepted)
    )
  })

  it('changes when the same file is re-picked, since that is a fresh draft', () => {
    const first = validateOdooAttachmentSelection([file('a.txt')], 0).accepted
    const second = validateOdooAttachmentSelection([file('a.txt')], 0).accepted
    expect(odooAttachmentDraftSetKey(second)).not.toBe(odooAttachmentDraftSetKey(first))
  })
})

describe('formatOdooAttachmentSize', () => {
  it('formats sub-megabyte sizes in KB', () => {
    expect(formatOdooAttachmentSize(2048)).toBe('2 KB')
  })

  it('formats megabyte-and-above sizes with one decimal', () => {
    expect(formatOdooAttachmentSize(5 * 1024 * 1024)).toBe('5.0 MB')
  })
})

describe('stripBase64DataUrlPrefix', () => {
  it('strips the data URL prefix', () => {
    expect(stripBase64DataUrlPrefix('data:text/plain;base64,aGVsbG8=')).toBe('aGVsbG8=')
  })

  it('returns the input unchanged when there is no comma', () => {
    expect(stripBase64DataUrlPrefix('aGVsbG8=')).toBe('aGVsbG8=')
  })
})

describe('readOdooAttachmentAsBase64', () => {
  it('reads a file into its base64 payload without the data: prefix', async () => {
    const payload = await readOdooAttachmentAsBase64(file('hello.txt'))
    expect(payload).toBe(Buffer.from('xxxx').toString('base64'))
  })
})
