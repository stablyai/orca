// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { BotUpNextCount } from './BotUpNextCount'

afterEach(cleanup)

describe('BotUpNextCount', () => {
  it('reveals Up next without the click also reaching the row', () => {
    const onReveal = vi.fn()
    const onRow = vi.fn()
    render(
      <TooltipProvider>
        <div onClick={onRow}>
          <BotUpNextCount count={1} onReveal={onReveal} />
        </div>
      </TooltipProvider>
    )
    fireEvent.click(screen.getByRole('button'))
    expect(onReveal).toHaveBeenCalledTimes(1)
    expect(onRow).not.toHaveBeenCalled()
  })
})
