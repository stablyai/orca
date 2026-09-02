import { describe, expect, it, vi } from 'vitest'
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
