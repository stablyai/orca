import { describe, expect, it } from 'vitest'
import {
  MOBILE_WEB_FILE_CONTENT_MAX_BASE64_CHARS,
  MOBILE_WEB_FILE_CONTENT_MAX_BYTES,
  MOBILE_WEB_FILE_LIST_LIMIT,
  MobileWebFileListPayloadSchema,
  MobileWebFileChunkPayloadSchema,
  MobileWebFileChunkResultSchema,
  MobileWebFileDirectoryPayloadSchema,
  MobileWebFileDirectoryResultSchema,
  MobileWebFileReadPayloadSchema,
  MobileWebFileReadResultSchema,
  MobileWebFileSearchPayloadSchema
} from './bridge-operation-contract'

describe('mobile web file operation contract', () => {
  it('accepts bounded relative paths and rejects traversal or absolute forms', () => {
    expect(
      MobileWebFileReadPayloadSchema.safeParse({
        workspaceId: 'workspace-1',
        relativePath: 'src/components/app.tsx'
      }).success
    ).toBe(true)
    for (const relativePath of ['../secret', 'src/../secret', '/etc/passwd', 'C:\\secret']) {
      expect(
        MobileWebFileReadPayloadSchema.safeParse({
          workspaceId: 'workspace-1',
          relativePath
        }).success
      ).toBe(false)
    }
  })

  it('bounds list/search requests and file response content', () => {
    expect(
      MobileWebFileListPayloadSchema.safeParse({
        workspaceId: 'workspace-1',
        limit: MOBILE_WEB_FILE_LIST_LIMIT + 1
      }).success
    ).toBe(false)
    expect(
      MobileWebFileSearchPayloadSchema.safeParse({
        workspaceId: 'workspace-1',
        query: 'x'.repeat(257),
        limit: 10
      }).success
    ).toBe(false)
    expect(
      MobileWebFileReadResultSchema.safeParse({
        workspaceId: 'workspace-1',
        relativePath: 'src/app.ts',
        contentBase64: 'A'.repeat(MOBILE_WEB_FILE_CONTENT_MAX_BASE64_CHARS + 1),
        truncated: false,
        byteLength: MOBILE_WEB_FILE_CONTENT_MAX_BYTES + 1
      }).success
    ).toBe(false)
  })

  it('allows the directory root while rejecting unsafe entries and mismatched chunks', () => {
    expect(
      MobileWebFileDirectoryPayloadSchema.safeParse({
        workspaceId: 'workspace-1',
        relativePath: '',
        limit: 128
      }).success
    ).toBe(true)
    expect(
      MobileWebFileDirectoryResultSchema.safeParse({
        workspaceId: 'workspace-1',
        relativePath: '',
        revision: 'a'.repeat(64),
        entries: [{ name: '../secret', isDirectory: false, isSymlink: false }],
        truncated: false
      }).success
    ).toBe(false)
    expect(
      MobileWebFileChunkPayloadSchema.safeParse({
        workspaceId: 'workspace-1',
        relativePath: 'src/app.ts',
        offset: 0,
        length: 0
      }).success
    ).toBe(false)
    expect(
      MobileWebFileChunkResultSchema.safeParse({
        workspaceId: 'workspace-1',
        relativePath: 'src/app.ts',
        offset: 0,
        contentBase64: 'eA==',
        bytesRead: 2,
        eof: false
      }).success
    ).toBe(false)
  })
})
