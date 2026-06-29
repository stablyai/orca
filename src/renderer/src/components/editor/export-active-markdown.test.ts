// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { exportActiveMarkdownToPdf } from './export-active-markdown'
import { getActiveMarkdownExportPayload } from './markdown-export-extract'

vi.mock('sonner', () => ({
  toast: {
    dismiss: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(() => 'toast-id'),
    success: vi.fn()
  }
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('./markdown-export-extract', () => ({
  getActiveMarkdownExportPayload: vi.fn()
}))

describe('exportActiveMarkdownToPdf', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        export: {
          htmlToPdf: vi.fn()
        }
      }
    })
  })

  it('surfaces payload extraction failures through the export toast', async () => {
    vi.mocked(getActiveMarkdownExportPayload).mockRejectedValue(
      new Error('Failed to inline image for PDF export: Unable to fetch blob image')
    )

    await exportActiveMarkdownToPdf({
      fileId: '/repo/docs/readme.md',
      root: document.createElement('div')
    })

    expect(toast.loading).toHaveBeenCalledWith('Exporting PDF...')
    expect(window.api.export.htmlToPdf).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith(
      'Failed to inline image for PDF export: Unable to fetch blob image',
      { id: 'toast-id' }
    )
  })
})
