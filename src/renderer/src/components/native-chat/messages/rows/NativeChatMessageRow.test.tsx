// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { MessageRow } from './NativeChatMessageRow'

afterEach(cleanup)

describe('MessageRow sent image prompt markers', () => {
  it('draws and copies a user message without the [Image #N] its send wrote mid-sentence', async () => {
    const writeClipboardText = vi.fn().mockResolvedValue(undefined)
    Object.assign(window, { api: { ui: { writeClipboardText } } })

    render(
      <TooltipProvider>
        <MessageRow
          message={{
            id: 'message',
            role: 'user',
            timestamp: 0,
            source: 'transcript',
            blocks: [
              { type: 'text', text: 'Compare this [Image #1] with `[Image #1]`' },
              { type: 'image-ref', path: '/tmp/screenshot.png', alt: 'Screenshot' }
            ]
          }}
          expandSignal={false}
          onScrollMessageToTop={vi.fn()}
        />
      </TooltipProvider>
    )
    expect(screen.getByText('[Image #1]').tagName).toBe('CODE')
    expect(screen.getByText(/Compare this\s+with/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Copy message' }))
    await waitFor(() => {
      expect(writeClipboardText).toHaveBeenCalledWith('Compare this  with `[Image #1]`')
    })
  })

  it('omits the copy button when a user message has only its sent [Image #1] marker and image', () => {
    render(
      <TooltipProvider>
        <MessageRow
          message={{
            id: 'image-only',
            role: 'user',
            timestamp: 0,
            source: 'transcript',
            blocks: [
              { type: 'text', text: '[Image #1]' },
              { type: 'image-ref', path: '/tmp/screenshot.png', alt: 'Screenshot' }
            ]
          }}
          expandSignal={false}
          onScrollMessageToTop={vi.fn()}
        />
      </TooltipProvider>
    )
    expect(screen.queryByText(/\[Image #1\]/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Copy message' })).toBeNull()
  })
})
