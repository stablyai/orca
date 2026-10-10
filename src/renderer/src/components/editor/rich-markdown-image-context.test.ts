// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createRichMarkdownImageResolverContext,
  readRichMarkdownImageRuntimeContext
} from './rich-markdown-image-context'
import { prewarmMarkdownPreviewLocalImages } from './markdown-preview-local-images'
import { loadLocalImageSrc, resetLocalImageSrcStateForTests } from './useLocalImageSrc'

vi.mock('@/lib/connection-context', () => ({ getConnectionId: () => null }))

describe('image reads for a document whose owner is unresolved', () => {
  afterEach(() => {
    resetLocalImageSrcStateForTests()
    vi.unstubAllGlobals()
  })

  it('never reads the image from this machine', async () => {
    const readFile = vi.fn(async () => ({ content: '', isBinary: true }))
    vi.stubGlobal('window', { ...window, api: { fs: { readFile } } })
    const context = createRichMarkdownImageResolverContext({
      filePath: '/srv/repo/doc.md',
      runtimeTarget: null,
      worktreeId: 'repo::/srv/repo',
      worktreeRoot: '/srv/repo'
    })
    // `undefined` would mean a plain local file; an unresolved owner must block instead.
    expect(context.runtimeContext).toBeNull()
    // The editor's image node view reads the stored context back; null must survive that.
    expect(
      readRichMarkdownImageRuntimeContext({ runtimeContext: context.runtimeContext })
    ).toBeNull()

    await expect(
      loadLocalImageSrc('./shot.png', '/srv/repo/doc.md', undefined, context.runtimeContext)
    ).resolves.toBeNull()
    const loadImage = vi.fn(async () => null)
    prewarmMarkdownPreviewLocalImages('![shot](./shot.png)', '/srv/repo/doc.md', {
      runtimeContext: null,
      loadImage
    })
    await Promise.resolve()
    expect(loadImage).not.toHaveBeenCalled()
    expect(readFile).not.toHaveBeenCalled()
  })

  it('keeps no workspace distinct from an unresolved owner', () => {
    expect(
      createRichMarkdownImageResolverContext({
        filePath: '/notes/doc.md',
        runtimeTarget: { kind: 'local' },
        worktreeId: '',
        worktreeRoot: null
      }).runtimeContext
    ).toBeUndefined()
  })
})
