import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTrelloImageSrcResolver,
  clearTrelloImageCache,
  clearTrelloImageCacheForIdentity
} from './trello-authenticated-images'
import { trelloDownloadImage } from '@/runtime/runtime-trello-client'

vi.mock('@/runtime/runtime-trello-client', () => ({
  trelloDownloadImage: vi.fn()
}))

const mockedDownloadImage = vi.mocked(trelloDownloadImage)

describe('Trello authenticated image resolver', () => {
  beforeEach(() => {
    mockedDownloadImage.mockReset()
    clearTrelloImageCache()
  })

  it('leaves non-Trello image URLs to the default renderer path', async () => {
    const resolver = createTrelloImageSrcResolver(undefined)

    await expect(resolver('https://example.com/image.png')).resolves.toBeUndefined()

    expect(mockedDownloadImage).not.toHaveBeenCalled()
  })

  it('downloads authenticated Trello card images through runtime and returns a blob URL', async () => {
    const blobUrl = 'blob:trello-image'
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValueOnce(blobUrl)
    mockedDownloadImage.mockResolvedValueOnce({
      ok: true,
      contentType: 'image/png',
      contentBase64: 'iVBORw=='
    })
    const settings = { activeRuntimeEnvironmentId: null }
    const resolver = createTrelloImageSrcResolver(settings as never)
    const src = 'https://trello.com/1/cards/card-1/attachments/a-1/download/image.png'

    await expect(resolver(src)).resolves.toBe(blobUrl)

    expect(mockedDownloadImage).toHaveBeenCalledWith(settings, src)
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob))
    createObjectURL.mockRestore()
  })

  it('proxies API-hosted Trello card image URLs', async () => {
    const blobUrl = 'blob:trello-api-image'
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValueOnce(blobUrl)
    mockedDownloadImage.mockResolvedValueOnce({
      ok: true,
      contentType: 'image/jpeg',
      contentBase64: '/9j/'
    })
    const resolver = createTrelloImageSrcResolver(undefined)
    const src = 'https://api.trello.com/1/cards/card-1/attachments/a-1/download/image.jpg'

    await expect(resolver(src)).resolves.toBe(blobUrl)

    expect(mockedDownloadImage).toHaveBeenCalledWith(undefined, src)
    createObjectURL.mockRestore()
  })

  it('blocks direct browser loading when authenticated download fails', async () => {
    mockedDownloadImage.mockResolvedValueOnce({ ok: false, error: 'Not connected' })
    const resolver = createTrelloImageSrcResolver(undefined)

    await expect(
      resolver('https://trello.com/1/cards/card-2/attachments/a-2/download/image.png')
    ).resolves.toBeNull()
  })

  it('separates cache entries by runtime environment and account identity', async () => {
    const src = 'https://trello.com/1/cards/c/attachments/a/download/image.png'
    const createObjectURL = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValueOnce('blob:id-a')
      .mockReturnValueOnce('blob:id-b')
      .mockReturnValueOnce('blob:id-c')
    mockedDownloadImage.mockResolvedValue({
      ok: true,
      contentType: 'image/png',
      contentBase64: 'iVBORw=='
    })

    const resolverA = createTrelloImageSrcResolver(undefined, {
      runtimeEnvironmentId: 'runtime-1',
      accountId: 'alice'
    })
    const resolverB = createTrelloImageSrcResolver(undefined, {
      runtimeEnvironmentId: 'runtime-1',
      accountId: 'bob'
    })
    const resolverC = createTrelloImageSrcResolver(undefined, {
      runtimeEnvironmentId: 'runtime-2',
      accountId: 'alice'
    })

    const urlA = await resolverA(src)
    const urlB = await resolverB(src)
    const urlC = await resolverC(src)

    expect(urlA).toBe('blob:id-a')
    expect(urlB).toBe('blob:id-b')
    expect(urlC).toBe('blob:id-c')
    expect(mockedDownloadImage).toHaveBeenCalledTimes(3)

    // Each identity gets its own cached blob — re-fetching returns the same blob.
    const urlA2 = await resolverA(src)
    expect(urlA2).toBe(urlA)
    expect(mockedDownloadImage).toHaveBeenCalledTimes(3) // no new download

    createObjectURL.mockRestore()
  })

  it('revokes old blob URL when the same identity re-fetches the same source', async () => {
    const src = 'https://trello.com/1/cards/c/attachments/a/download/image.png'
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValueOnce('blob:rev-1')
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL')

    mockedDownloadImage.mockResolvedValueOnce({
      ok: true,
      contentType: 'image/png',
      contentBase64: 'AAAA'
    })
    const resolver = createTrelloImageSrcResolver(undefined, {
      runtimeEnvironmentId: 'r1',
      accountId: 'u1'
    })
    const first = await resolver(src)
    expect(first).toBe('blob:rev-1')
    expect(revokeSpy).not.toHaveBeenCalled()

    // Second fetch for same identity — should return cached, no revocation.
    const cached = await resolver(src)
    expect(cached).toBe('blob:rev-1')
    expect(revokeSpy).not.toHaveBeenCalled()

    createObjectURL.mockRestore()
    revokeSpy.mockRestore()
  })

  it('clearTrelloImageCache revokes all cached blob URLs', async () => {
    const src = 'https://trello.com/1/cards/c/attachments/a/download/image.png'
    const createObjectURL = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValueOnce('blob:all-1')
      .mockReturnValueOnce('blob:all-2')
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL')
    mockedDownloadImage.mockResolvedValue({
      ok: true,
      contentType: 'image/png',
      contentBase64: 'AAAA'
    })

    const resolverA = createTrelloImageSrcResolver(undefined, {
      runtimeEnvironmentId: 'r1',
      accountId: 'alice'
    })
    const resolverB = createTrelloImageSrcResolver(undefined, {
      runtimeEnvironmentId: 'r2',
      accountId: 'bob'
    })
    await resolverA(src)
    await resolverB(src)

    clearTrelloImageCache()

    expect(revokeSpy).toHaveBeenCalledWith('blob:all-1')
    expect(revokeSpy).toHaveBeenCalledWith('blob:all-2')

    createObjectURL.mockRestore()
    revokeSpy.mockRestore()
  })

  it('clearTrelloImageCacheForIdentity revokes only entries for the given identity', async () => {
    const src = 'https://trello.com/1/cards/c/attachments/a/download/image.png'
    const createObjectURL = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValueOnce('blob:part-1')
      .mockReturnValueOnce('blob:part-2')
      .mockReturnValueOnce('blob:part-3')
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL')
    mockedDownloadImage.mockResolvedValue({
      ok: true,
      contentType: 'image/png',
      contentBase64: 'AAAA'
    })

    const resolverAlice = createTrelloImageSrcResolver(undefined, {
      runtimeEnvironmentId: 'r1',
      accountId: 'alice'
    })
    const resolverBob = createTrelloImageSrcResolver(undefined, {
      runtimeEnvironmentId: 'r1',
      accountId: 'bob'
    })
    await resolverAlice(src)
    await resolverBob(src)

    clearTrelloImageCacheForIdentity({ runtimeEnvironmentId: 'r1', accountId: 'alice' })

    expect(revokeSpy).toHaveBeenCalledWith('blob:part-1')
    expect(revokeSpy).not.toHaveBeenCalledWith('blob:part-2')

    // Bob's cache should still work without a new download.
    const cached = await resolverBob(src)
    expect(cached).toBe('blob:part-2')

    // Alice needs a fresh download.
    mockedDownloadImage.mockResolvedValueOnce({
      ok: true,
      contentType: 'image/png',
      contentBase64: 'BBBB'
    })
    const freshAlice = await resolverAlice(src)
    expect(freshAlice).toBe('blob:part-3')

    createObjectURL.mockRestore()
    revokeSpy.mockRestore()
  })

  it('works without explicit identity (backward compatible)', async () => {
    const blobUrl = 'blob:default-identity'
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValueOnce(blobUrl)
    mockedDownloadImage.mockResolvedValueOnce({
      ok: true,
      contentType: 'image/png',
      contentBase64: 'iVBORw=='
    })
    const resolver = createTrelloImageSrcResolver(undefined)
    const src = 'https://trello.com/1/cards/c/attachments/a/download/image.png'

    await expect(resolver(src)).resolves.toBe(blobUrl)
    createObjectURL.mockRestore()
  })
})
