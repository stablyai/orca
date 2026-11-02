import { describe, expect, it, vi, afterEach } from 'vitest'
import { saveMarkdownAndRefreshDocuments } from './useMarkdownDocuments'

describe('saveMarkdownAndRefreshDocuments', () => {
  it('does not refresh the document index after a failed write', async () => {
    const save = vi.fn().mockResolvedValue(false)
    const refresh = vi.fn().mockResolvedValue(undefined)

    await expect(saveMarkdownAndRefreshDocuments('draft', save, refresh)).resolves.toBe(false)

    expect(save).toHaveBeenCalledWith('draft')
    expect(refresh).not.toHaveBeenCalled()
  })

  it('refreshes the document index once after a successful write', async () => {
    const save = vi.fn().mockResolvedValue(true)
    const refresh = vi.fn().mockResolvedValue(undefined)

    await expect(saveMarkdownAndRefreshDocuments('draft', save, refresh)).resolves.toBe(true)

    expect(refresh).toHaveBeenCalledTimes(1)
  })
})

const { rejectAppStoreAccess } = vi.hoisted(() => ({
  rejectAppStoreAccess: vi.fn(() => {
    throw new Error('Pure helper tests must not access the app store')
  })
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(rejectAppStoreAccess, {
    getState: rejectAppStoreAccess,
    getInitialState: rejectAppStoreAccess,
    setState: rejectAppStoreAccess,
    subscribe: rejectAppStoreAccess
  })
}))

afterEach(() => {
  expect(rejectAppStoreAccess).not.toHaveBeenCalled()
})
