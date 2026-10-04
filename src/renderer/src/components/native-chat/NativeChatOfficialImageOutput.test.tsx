// @vitest-environment happy-dom
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { MessageRow } from './NativeChatMessageRow'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it.each(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])(
  'previews an official %s journal image with the existing renderer',
  async (mimeType) => {
    vi.stubGlobal('IntersectionObserver', undefined)
    const url = `data:${mimeType};base64,AQ==`
    const { container } = render(
      <MessageRow
        message={{
          id: 'official-image',
          role: 'assistant',
          source: 'transcript',
          timestamp: null,
          blocks: [{ type: 'image-ref', url, alt: 'DeepSeek Harness image' }]
        }}
        expandSignal={false}
        onScrollMessageToTop={() => undefined}
        runtimeContext={null}
      />
    )
    await waitFor(() => expect(container.querySelector('img')?.getAttribute('src')).toBe(url))
  }
)
