// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AutomationArgsCell } from './AutomationArgsCell'

afterEach(cleanup)

describe('argument details', () => {
  it('reveals full text on keyboard focus and opens scrollable details without activating the row', async () => {
    const onOpenRun = vi.fn()
    const value = `--model opus --add-dir "${'long-directory/'.repeat(100)}specs"`
    render(
      <TooltipProvider>
        <div onClick={onOpenRun} onKeyDown={onOpenRun}>
          <AutomationArgsCell value={value} effective />
        </div>
      </TooltipProvider>
    )
    const user = userEvent.setup()
    await user.tab()
    expect((await screen.findByRole('tooltip')).textContent).toContain(value)
    await user.keyboard('{Enter}')
    expect(screen.getByRole('dialog').textContent).toContain(value)
    expect(screen.getByRole('dialog').querySelector('[tabindex="0"]')).not.toBeNull()
    expect(onOpenRun).not.toHaveBeenCalled()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('reveals exact saved text on hover', async () => {
    render(
      <TooltipProvider>
        <AutomationArgsCell value='  --model "my model"  ' />
      </TooltipProvider>
    )
    await userEvent.setup().hover(screen.getByRole('button'))
    expect((await screen.findByRole('tooltip')).textContent).toContain('  --model "my model"  ')
  })

  it('distinguishes missing facts from known empty arguments', () => {
    const { rerender } = render(<AutomationArgsCell value={undefined} />)
    expect(screen.getByText('Unknown')).toBeDefined()
    rerender(<AutomationArgsCell value="" />)
    expect(screen.getByText('None')).toBeDefined()
  })
})
