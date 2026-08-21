// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { TooltipProvider } from '@/components/ui/tooltip'
import { SideQuestQuoteCard } from './SideQuestQuoteCard'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function renderQuote(onRemove = vi.fn()): void {
  render(
    <TooltipProvider>
      <SideQuestQuoteCard
        sourceLabel="README.md"
        text="Keep this requirement in view while composing the response."
        onRemove={onRemove}
      />
    </TooltipProvider>
  )
}

describe('SideQuestQuoteCard', () => {
  it('labels and removes quoted context without disclosure when the preview fits', async () => {
    const user = userEvent.setup()
    const onRemove = vi.fn()
    renderQuote(onRemove)

    expect(screen.getByText('Context from README.md')).toBeInTheDocument()
    expect(screen.getByText(/Keep this requirement/)).toHaveClass('line-clamp-3')
    expect(screen.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Remove context from README.md' }))
    expect(onRemove).toHaveBeenCalledOnce()
  })

  it('discloses a preview only when the rendered quote is clipped', async () => {
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(80)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(60)
    const user = userEvent.setup()
    renderQuote()

    const quote = screen.getByText(/Keep this requirement/)
    const disclosure = screen.getByRole('button', { name: 'Show more' })
    expect(disclosure).toHaveAttribute('aria-expanded', 'false')

    await user.click(disclosure)
    expect(quote).not.toHaveClass('line-clamp-3')
    expect(screen.getByRole('button', { name: 'Show less' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
  })
})
