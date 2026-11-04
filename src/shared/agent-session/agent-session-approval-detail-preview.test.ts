import { describe, expect, it } from 'vitest'
import { approvalDetailPreview } from './agent-session-approval-detail-preview'

describe('approvalDetailPreview', () => {
  it('keeps compact text complete and marks omitted lines or long arguments', () => {
    expect(approvalDetailPreview('git status')).toBe('git status')
    expect(approvalDetailPreview('one\ntwo\nthree\nfour\nfive')).toBe('one\ntwo\nthree\nfour…')
    expect(approvalDetailPreview(`${'x'.repeat(511)}😀suffix`)).toBe(`${'x'.repeat(511)}…`)
  })
})
