// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeChatCodeBlock } from './NativeChatCodeBlock'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('NativeChatCodeBlock', () => {
  it('copies only the fenced code and confirms success', async () => {
    const writeClipboardText = vi.fn().mockResolvedValue(undefined)
    Object.assign(window, { api: { ui: { writeClipboardText } } })

    render(
      <NativeChatCodeBlock language="typescript">
        <code>{'const answer = 42\nconsole.log(answer)\n'}</code>
      </NativeChatCodeBlock>
    )

    expect(screen.getByText('TypeScript')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }))

    await waitFor(() => {
      expect(writeClipboardText).toHaveBeenCalledWith('const answer = 42\nconsole.log(answer)\n')
    })
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument()
  })
})
