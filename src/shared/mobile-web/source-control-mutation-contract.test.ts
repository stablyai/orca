import { describe, expect, it } from 'vitest'
import {
  MOBILE_WEB_SOURCE_CONTROL_MUTATION_LIMIT,
  MobileWebSourceControlDiscardPayloadSchema,
  MobileWebSourceControlStagePayloadSchema,
  MobileWebSourceControlUnstagePayloadSchema
} from './source-control-mutation-contract'

const modified = {
  relativePath: 'src/app.ts',
  status: 'modified' as const,
  area: 'unstaged' as const
}

describe('mobile web source-control mutation contract', () => {
  it('accepts bounded stage and unstage snapshots', () => {
    expect(
      MobileWebSourceControlStagePayloadSchema.parse({
        workspaceId: 'workspace-1',
        expectedHead: 'a'.repeat(40),
        entries: [modified]
      })
    ).toMatchObject({ entries: [modified] })
    expect(
      MobileWebSourceControlUnstagePayloadSchema.parse({
        workspaceId: 'workspace-1',
        expectedHead: null,
        entries: [{ ...modified, area: 'staged' }]
      })
    ).toMatchObject({ entries: [{ area: 'staged' }] })
  })

  it('requires explicit confirmation and eligible discard entries', () => {
    expect(() =>
      MobileWebSourceControlDiscardPayloadSchema.parse({
        workspaceId: 'workspace-1',
        expectedHead: null,
        entries: [modified]
      })
    ).toThrow()
    expect(() =>
      MobileWebSourceControlDiscardPayloadSchema.parse({
        workspaceId: 'workspace-1',
        expectedHead: null,
        confirmation: 'discard-confirmed',
        entries: [{ ...modified, area: 'staged' }]
      })
    ).toThrow()
  })

  it('rejects duplicate and oversized path sets', () => {
    expect(() =>
      MobileWebSourceControlStagePayloadSchema.parse({
        workspaceId: 'workspace-1',
        expectedHead: null,
        entries: [modified, modified]
      })
    ).toThrow()
    expect(() =>
      MobileWebSourceControlStagePayloadSchema.parse({
        workspaceId: 'workspace-1',
        expectedHead: null,
        entries: Array.from(
          { length: MOBILE_WEB_SOURCE_CONTROL_MUTATION_LIMIT + 1 },
          (_, index) => ({ ...modified, relativePath: `src/${index}.ts` })
        )
      })
    ).toThrow()
  })
})
