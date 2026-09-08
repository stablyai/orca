import { describe, expect, it } from 'vitest'
import {
  MOBILE_WEB_COMMIT_MESSAGE_MAX_CHARACTERS,
  MOBILE_WEB_COMMIT_RESULT_ERROR_MAX_CHARACTERS,
  MobileWebSourceControlCommitPayloadSchema,
  MobileWebSourceControlCommitResultSchema,
  MobileWebSourceControlGenerateCommitMessageResultSchema
} from './source-control-commit-contract'

describe('mobile web source-control commit contract', () => {
  it('accepts a bounded commit message', () => {
    expect(
      MobileWebSourceControlCommitPayloadSchema.parse({
        workspaceId: 'workspace-1',
        message: 'feat: add mobile commit'
      })
    ).toEqual({ workspaceId: 'workspace-1', message: 'feat: add mobile commit' })
  })

  it('rejects blank, oversized and unexpectedly extended commit requests', () => {
    for (const candidate of [
      { message: ' ' },
      { message: 'x'.repeat(MOBILE_WEB_COMMIT_MESSAGE_MAX_CHARACTERS + 1) },
      { message: 'feat: amend', amend: true }
    ]) {
      expect(
        MobileWebSourceControlCommitPayloadSchema.safeParse({
          workspaceId: 'workspace-1',
          ...candidate
        }).success
      ).toBe(false)
    }
  })

  it('reads a refused commit from the result and bounds its error text', () => {
    expect(
      MobileWebSourceControlCommitResultSchema.parse({
        success: false,
        error: 'pre-commit hook failed'
      })
    ).toEqual({ success: false, error: 'pre-commit hook failed' })
    expect(
      MobileWebSourceControlCommitResultSchema.parse({
        success: false,
        error: 'x'.repeat(MOBILE_WEB_COMMIT_RESULT_ERROR_MAX_CHARACTERS + 1)
      }).error
    ).toHaveLength(MOBILE_WEB_COMMIT_RESULT_ERROR_MAX_CHARACTERS)
    expect(
      MobileWebSourceControlCommitResultSchema.parse({ success: true, hostPath: '/private/repo' })
    ).toEqual({ success: true })
  })

  it('bounds generated messages and strips undeclared host fields', () => {
    expect(() =>
      MobileWebSourceControlGenerateCommitMessageResultSchema.parse({
        workspaceId: 'workspace-1',
        previousHead: 'a'.repeat(40),
        status: 'generated',
        message: 'x'.repeat(MOBILE_WEB_COMMIT_MESSAGE_MAX_CHARACTERS + 1)
      })
    ).toThrow()
    expect(() =>
      MobileWebSourceControlGenerateCommitMessageResultSchema.parse({
        workspaceId: 'workspace-1',
        previousHead: 'a'.repeat(40),
        status: 'generated',
        message: 'feat: safe',
        commandOutput: '/private/repo'
      })
    ).toThrow()
  })
})
