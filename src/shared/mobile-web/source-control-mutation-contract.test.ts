import { describe, expect, it } from 'vitest'
import {
  MOBILE_WEB_SOURCE_CONTROL_MUTATION_LIMIT,
  MobileWebSourceControlMutationPayloadSchema
} from './source-control-mutation-contract'

describe('mobile web source-control mutation contract', () => {
  it('accepts a bounded set of workspace-relative paths', () => {
    expect(
      MobileWebSourceControlMutationPayloadSchema.parse({
        workspaceId: 'workspace-1',
        relativePaths: ['src/app.ts', 'src/other.ts']
      })
    ).toEqual({ workspaceId: 'workspace-1', relativePaths: ['src/app.ts', 'src/other.ts'] })
  })

  it('rejects duplicate, empty and oversized path sets', () => {
    expect(
      MobileWebSourceControlMutationPayloadSchema.safeParse({
        workspaceId: 'workspace-1',
        relativePaths: ['src/app.ts', 'src/app.ts']
      }).success
    ).toBe(false)
    expect(
      MobileWebSourceControlMutationPayloadSchema.safeParse({
        workspaceId: 'workspace-1',
        relativePaths: []
      }).success
    ).toBe(false)
    expect(
      MobileWebSourceControlMutationPayloadSchema.safeParse({
        workspaceId: 'workspace-1',
        relativePaths: Array.from(
          { length: MOBILE_WEB_SOURCE_CONTROL_MUTATION_LIMIT + 1 },
          (_, index) => `src/${index}.ts`
        )
      }).success
    ).toBe(false)
  })

  it('rejects a path that escapes the workspace', () => {
    expect(
      MobileWebSourceControlMutationPayloadSchema.safeParse({
        workspaceId: 'workspace-1',
        relativePaths: ['../outside.ts']
      }).success
    ).toBe(false)
  })
})
