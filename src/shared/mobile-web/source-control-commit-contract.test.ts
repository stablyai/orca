import { describe, expect, it } from 'vitest'
import {
  MOBILE_WEB_COMMIT_MESSAGE_MAX_CHARACTERS,
  MOBILE_WEB_COMMIT_STAGED_ENTRY_LIMIT,
  MobileWebSourceControlCommitPayloadSchema,
  MobileWebSourceControlGenerateCommitMessageResultSchema
} from './source-control-commit-contract'

const staged = {
  relativePath: 'src/app.ts',
  status: 'modified' as const,
  area: 'staged' as const
}

describe('mobile web source-control commit contract', () => {
  it('accepts a bounded commit tied to a full HEAD and staged snapshot', () => {
    expect(
      MobileWebSourceControlCommitPayloadSchema.parse({
        workspaceId: 'workspace-1',
        expectedHead: 'a'.repeat(40),
        stagedEntries: [staged],
        message: 'feat: add mobile commit'
      })
    ).toMatchObject({ stagedEntries: [staged] })
  })

  it('rejects blank or oversized messages and unsafe staged snapshots', () => {
    for (const candidate of [
      { message: ' ', stagedEntries: [staged] },
      {
        message: 'x'.repeat(MOBILE_WEB_COMMIT_MESSAGE_MAX_CHARACTERS + 1),
        stagedEntries: [staged]
      },
      { message: 'feat: duplicate', stagedEntries: [staged, staged] },
      {
        message: 'feat: unresolved',
        stagedEntries: [{ ...staged, conflictStatus: 'unresolved' }]
      },
      {
        message: 'feat: too many',
        stagedEntries: Array.from(
          { length: MOBILE_WEB_COMMIT_STAGED_ENTRY_LIMIT + 1 },
          (_, index) => ({ ...staged, relativePath: `src/${index}.ts` })
        )
      }
    ]) {
      expect(() =>
        MobileWebSourceControlCommitPayloadSchema.parse({
          workspaceId: 'workspace-1',
          expectedHead: 'a'.repeat(40),
          ...candidate
        })
      ).toThrow()
    }
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
