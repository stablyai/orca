import { describe, expect, it } from 'vitest'
import {
  MOBILE_WEB_BROWSER_FRAME_CHUNK_BASE64_MAX_LENGTH,
  MobileWebBrowserEventSchema,
  MobileWebBrowserNavigatePayloadSchema,
  MobileWebBrowserPointerPayloadSchema
} from './browser-operation-contract'

describe('mobile web browser operation contract', () => {
  it('admits only bounded browser navigation and pointer operations', () => {
    expect(
      MobileWebBrowserNavigatePayloadSchema.safeParse({
        workspaceId: 'workspace-1',
        pageId: 'browser-1',
        url: 'https://example.com'
      }).success
    ).toBe(true)
    expect(
      MobileWebBrowserNavigatePayloadSchema.safeParse({
        workspaceId: 'workspace-1',
        pageId: 'browser-1',
        url: 'javascript:alert(1)'
      }).success
    ).toBe(false)
    expect(
      MobileWebBrowserNavigatePayloadSchema.safeParse({
        workspaceId: 'workspace-1',
        pageId: 'browser-1',
        url: 'https://example.com/callback?access_token=secret'
      }).success
    ).toBe(false)
    expect(
      MobileWebBrowserNavigatePayloadSchema.safeParse({
        workspaceId: 'workspace-1',
        pageId: 'browser-1',
        url: 'file:///private/repository/secret.txt'
      }).success
    ).toBe(false)
    expect(
      MobileWebBrowserPointerPayloadSchema.safeParse({
        workspaceId: 'workspace-1',
        pageId: 'browser-1',
        action: 'click',
        x: 10,
        y: 20,
        button: 'left',
        modifiers: ['ctrl'],
        arbitraryRpc: 'browser.eval'
      }).success
    ).toBe(false)
  })

  it('bounds individual frame chunks below the bridge message ceiling', () => {
    const base = {
      type: 'frameChunk',
      frameSequence: 1,
      format: 'jpeg',
      metadata: { deviceWidth: 390, deviceHeight: 640 },
      imageBytes: 1,
      chunkIndex: 0,
      chunkCount: 1
    } as const

    expect(MobileWebBrowserEventSchema.safeParse({ ...base, data: 'AA==' }).success).toBe(true)
    expect(
      MobileWebBrowserEventSchema.safeParse({
        ...base,
        data: 'A'.repeat(MOBILE_WEB_BROWSER_FRAME_CHUNK_BASE64_MAX_LENGTH + 1)
      }).success
    ).toBe(false)
  })
})
