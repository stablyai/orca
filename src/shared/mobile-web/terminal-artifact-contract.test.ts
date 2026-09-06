import { describe, expect, it } from 'vitest'
import {
  MOBILE_WEB_TERMINAL_PATH_MAX_CHARACTERS,
  MobileWebTerminalArtifactChunkPayloadSchema,
  MobileWebTerminalArtifactChunkResultSchema,
  MobileWebTerminalPathResolvePayloadSchema,
  MobileWebTerminalPathResolveResultSchema
} from './terminal-artifact-contract'

describe('mobile web terminal artifact contract', () => {
  it('accepts bounded path candidates while rejecting controls and unknown fields', () => {
    expect(
      MobileWebTerminalPathResolvePayloadSchema.safeParse({
        workspaceId: 'workspace-1',
        tabId: 'terminal-1',
        pathText: '/tmp/report.png',
        line: null,
        column: null
      }).success
    ).toBe(true)
    for (const pathText of [
      '/tmp/report.png\nignored',
      '\0/tmp/report.png',
      'x'.repeat(MOBILE_WEB_TERMINAL_PATH_MAX_CHARACTERS + 1)
    ]) {
      expect(
        MobileWebTerminalPathResolvePayloadSchema.safeParse({
          workspaceId: 'workspace-1',
          tabId: 'terminal-1',
          pathText,
          line: null,
          column: null
        }).success
      ).toBe(false)
    }
  })

  it('never permits absolute paths or grant IDs in artifact results', () => {
    const result = {
      kind: 'terminal-artifact',
      workspaceId: 'workspace-1',
      token: 'T'.repeat(43),
      displayName: 'report.png',
      previewKind: 'raster',
      line: null,
      column: null
    }
    expect(MobileWebTerminalPathResolveResultSchema.parse(result)).toEqual(result)
    expect(
      MobileWebTerminalPathResolveResultSchema.safeParse({
        ...result,
        absolutePath: '/tmp/report.png',
        grantId: 'desktop-grant'
      }).success
    ).toBe(false)
  })

  it('binds chunks to an opaque token and verifies decoded lengths', () => {
    const payload = {
      workspaceId: 'workspace-1',
      tabId: 'terminal-1',
      token: 'T'.repeat(43),
      offset: 0,
      length: 3
    }
    expect(MobileWebTerminalArtifactChunkPayloadSchema.safeParse(payload).success).toBe(true)
    expect(
      MobileWebTerminalArtifactChunkResultSchema.safeParse({
        workspaceId: payload.workspaceId,
        tabId: payload.tabId,
        token: payload.token,
        offset: payload.offset,
        contentBase64: 'AAH/',
        bytesRead: 3,
        eof: true
      }).success
    ).toBe(true)
    expect(
      MobileWebTerminalArtifactChunkResultSchema.safeParse({
        workspaceId: payload.workspaceId,
        tabId: payload.tabId,
        token: payload.token,
        offset: payload.offset,
        contentBase64: 'AA==',
        bytesRead: 2,
        eof: true
      }).success
    ).toBe(false)
    expect(
      MobileWebTerminalArtifactChunkResultSchema.safeParse({
        workspaceId: payload.workspaceId,
        tabId: payload.tabId,
        token: payload.token,
        offset: payload.offset,
        contentBase64: 'AB==',
        bytesRead: 1,
        eof: true
      }).success
    ).toBe(false)
  })
})
