// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { CheckRunCopyButton } from './CheckRunCopyButton'

const writeClipboardText = vi.fn<(text: string) => Promise<void>>()

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

afterEach(cleanup)

beforeEach(() => {
  writeClipboardText.mockReset().mockResolvedValue(undefined)
  Object.assign(window, { api: { ui: { writeClipboardText } } })
})

function renderCopyButton(text: string): void {
  render(
    <TooltipProvider>
      <CheckRunCopyButton text={text} label="Copy annotations" />
    </TooltipProvider>
  )
}

describe('CheckRunCopyButton', () => {
  it('copies the card text and shows copied feedback', async () => {
    renderCopyButton('src/main.ts:10\nBuild failed')

    const copyButton = screen.getByRole('button', { name: 'Copy annotations' })
    fireEvent.click(copyButton)

    await waitFor(() =>
      expect(writeClipboardText).toHaveBeenCalledWith('src/main.ts:10\nBuild failed')
    )
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeDefined()
  })

  it('disables the action when there is no card text', () => {
    renderCopyButton('')

    const copyButton = screen.getByRole('button', { name: 'Nothing to copy' })
    expect((copyButton as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(copyButton)
    expect(writeClipboardText).not.toHaveBeenCalled()
  })
})
