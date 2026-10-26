import { describe, expect, it } from 'vitest'
import { codexStructuredPermissionPolicy } from './codex-permission-policy'

const FULL_ACCESS = {
  approvalPolicy: 'never',
  sandbox: 'danger-full-access',
  approvalsReviewer: 'user'
}
const ASK = { approvalPolicy: 'on-request', sandbox: 'read-only', approvalsReviewer: 'user' }

describe('codexStructuredPermissionPolicy', () => {
  it('maps Full access to no prompts and no sandbox', () => {
    expect(codexStructuredPermissionPolicy('full-access')).toEqual(FULL_ACCESS)
  })

  it('states every Ask field, the human reviewer too', () => {
    expect(codexStructuredPermissionPolicy('ask')).toEqual(ASK)
  })

  it('keeps Approve for me in the configured workspace sandbox', () => {
    expect(codexStructuredPermissionPolicy('auto')).toEqual({
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      approvalsReviewer: 'auto_review'
    })
  })

  it('names a sandbox mode for every mode', () => {
    for (const mode of ['ask', 'auto', 'full-access'] as const) {
      expect(codexStructuredPermissionPolicy(mode)).not.toHaveProperty('sandboxPolicy')
      expect(typeof codexStructuredPermissionPolicy(mode).sandbox).toBe('string')
    }
  })

  it('asks for a mode Codex does not have', () => {
    expect(codexStructuredPermissionPolicy('accept-edits')).toEqual(ASK)
  })
})
