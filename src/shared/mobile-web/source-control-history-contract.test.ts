import { describe, expect, it } from 'vitest'
import {
  MOBILE_WEB_SOURCE_CONTROL_BRANCH_LIMIT,
  MOBILE_WEB_SOURCE_CONTROL_COMPARE_ENTRY_LIMIT,
  MOBILE_WEB_SOURCE_CONTROL_HISTORY_MAX_LIMIT,
  MobileWebSourceControlBranchComparePayloadSchema,
  MobileWebSourceControlBranchCompareResultSchema,
  MobileWebSourceControlBranchesResultSchema,
  MobileWebSourceControlCommitComparePayloadSchema,
  MobileWebSourceControlHistoryResultSchema
} from './source-control-history-contract'

const OID = 'a'.repeat(40)

describe('mobile web source-control history contract', () => {
  it('bounds branch names and rejects refs that can be parsed as Git options', () => {
    expect(
      MobileWebSourceControlBranchesResultSchema.safeParse({
        workspaceId: 'workspace-1',
        current: 'main',
        branches: Array.from(
          { length: MOBILE_WEB_SOURCE_CONTROL_BRANCH_LIMIT },
          (_, index) => `branch-${index}`
        ),
        totalCount: MOBILE_WEB_SOURCE_CONTROL_BRANCH_LIMIT,
        truncated: false
      }).success
    ).toBe(true)
    expect(
      MobileWebSourceControlBranchComparePayloadSchema.safeParse({
        workspaceId: 'workspace-1',
        baseRef: '--upload-pack=malicious'
      }).success
    ).toBe(false)
  })

  it('requires full commit object IDs and bounded history content', () => {
    expect(
      MobileWebSourceControlCommitComparePayloadSchema.safeParse({
        workspaceId: 'workspace-1',
        commitId: 'abc1234'
      }).success
    ).toBe(false)
    expect(
      MobileWebSourceControlHistoryResultSchema.safeParse({
        workspaceId: 'workspace-1',
        items: Array.from({ length: MOBILE_WEB_SOURCE_CONTROL_HISTORY_MAX_LIMIT }, (_, index) => ({
          id: index.toString(16).padStart(40, '0'),
          parentIds: [],
          displayId: index.toString(16),
          subject: 'subject',
          message: 'message',
          references: []
        })),
        hasIncomingChanges: false,
        hasOutgoingChanges: false,
        hasMore: false,
        limit: MOBILE_WEB_SOURCE_CONTROL_HISTORY_MAX_LIMIT
      }).success
    ).toBe(true)
    expect(
      MobileWebSourceControlHistoryResultSchema.safeParse({
        workspaceId: 'workspace-1',
        items: [
          {
            id: OID,
            parentIds: [],
            displayId: 'aaaaaaa',
            subject: 'subject',
            message: 'x'.repeat(8 * 1024 + 1),
            references: []
          }
        ],
        hasIncomingChanges: false,
        hasOutgoingChanges: false,
        hasMore: false,
        limit: 50
      }).success
    ).toBe(false)
  })

  it('caps compare entries and rejects unsafe repository paths', () => {
    const result = {
      workspaceId: 'workspace-1',
      baseRef: 'main',
      compareRef: 'HEAD',
      baseOid: OID,
      headOid: 'b'.repeat(40),
      mergeBase: OID,
      changedFiles: MOBILE_WEB_SOURCE_CONTROL_COMPARE_ENTRY_LIMIT,
      status: 'ready',
      revision: 'c'.repeat(64),
      offset: 0,
      totalEntries: MOBILE_WEB_SOURCE_CONTROL_COMPARE_ENTRY_LIMIT,
      entries: Array.from(
        { length: MOBILE_WEB_SOURCE_CONTROL_COMPARE_ENTRY_LIMIT },
        (_, index) => ({
          relativePath: `src/file-${index}.ts`,
          status: 'modified'
        })
      ),
      nextOffset: null,
      truncated: false
    }
    expect(MobileWebSourceControlBranchCompareResultSchema.safeParse(result).success).toBe(true)
    expect(
      MobileWebSourceControlBranchCompareResultSchema.safeParse({
        ...result,
        entries: [{ relativePath: '../secret', status: 'modified' }]
      }).success
    ).toBe(false)
  })
})
