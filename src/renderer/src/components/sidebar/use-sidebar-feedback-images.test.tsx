// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FeedbackImageDraft } from '@/lib/feedback-image-attachments'
import { useSidebarFeedbackImages } from './use-sidebar-feedback-images'

const { readFeedbackImageFiles } = vi.hoisted(() => ({ readFeedbackImageFiles: vi.fn() }))

vi.mock('@/lib/feedback-image-attachments', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readFeedbackImageFiles
}))

vi.mock('sonner', () => ({ toast: { warning: vi.fn(), error: vi.fn() } }))

type HookResult = ReturnType<typeof useSidebarFeedbackImages>

let container: HTMLDivElement
let root: Root
let latest: HookResult | undefined

function Harness(): null {
  latest = useSidebarFeedbackImages({
    open: false,
    isSubmitting: false,
    mountedRef: { current: true }
  })
  return null
}

function draft(id: string, bytes: number): FeedbackImageDraft {
  return {
    id,
    name: `${id}.png`,
    contentType: 'image/png',
    bytes,
    data: new Uint8Array([1]),
    previewUrl: `blob:${id}`
  }
}

beforeEach(() => {
  readFeedbackImageFiles.mockReset()
  URL.revokeObjectURL = vi.fn()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root.render(<Harness />)
  })
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  latest = undefined
})

describe('useSidebarFeedbackImages', () => {
  // Why: the read callback clears its pending reservation before React
  // re-renders, so rendered state alone would briefly undercount the budget.
  it('counts a just-read batch when another add lands before the re-render', async () => {
    let finishFirstRead: ((value: unknown) => void) | undefined
    readFeedbackImageFiles.mockReturnValueOnce(
      new Promise((resolve) => {
        finishFirstRead = resolve
      })
    )
    readFeedbackImageFiles.mockReturnValue(new Promise(() => {}))
    const first = new File(['x'], 'first.png', { type: 'image/png' })
    const second = new File(['x'], 'second.png', { type: 'image/png' })
    const firstBytes = 3 * 1024 * 1024

    act(() => {
      latest!.handleAddFiles([first])
    })

    await act(async () => {
      finishFirstRead?.({ images: [draft('first', firstBytes)], errors: [] })
      await Promise.resolve()
      await Promise.resolve()
      // Still inside act: the first batch has committed to the ref, not to state.
      expect(latest!.images).toEqual([])
      latest!.handleAddFiles([second])
    })

    expect(readFeedbackImageFiles).toHaveBeenNthCalledWith(2, [second], 1, firstBytes)
  })
})
