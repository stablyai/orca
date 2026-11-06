import { describe, expect, it } from 'vitest'
import { approvalDetailPreview } from './agent-session-approval-detail-preview'

describe('approvalDetailPreview', () => {
  it('keeps compact text complete and marks omitted lines or long arguments', () => {
    expect(approvalDetailPreview('git status')).toBe('git status')
    expect(approvalDetailPreview('add /p\n\nl1\nl2\n')).toBe('add /p\n\nl1\nl2\n')
    expect(approvalDetailPreview(`${'x'.repeat(512)}\n`)).toBe(`${'x'.repeat(512)}\n`)
    expect(approvalDetailPreview('one\ntwo\nthree\nfour\nfive')).toBe('one\ntwo\nthree\nfour…')
    expect(approvalDetailPreview(`${'x'.repeat(511)}😀suffix`)).toBe(`${'x'.repeat(511)}…`)
  })
})
