// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExpandableMermaidDiagram } from './MermaidDiagramLightbox'
import { TooltipProvider } from '@/components/ui/tooltip'

vi.mock('./MermaidBlock', () => ({
  default: function MermaidBlock() {
    return (
      <div className="mermaid-block">
        <svg viewBox="0 0 800 400" />
      </div>
    )
  }
}))

afterEach(() => {
  cleanup()
})

function renderDiagram(): void {
  render(
    <TooltipProvider>
      <ExpandableMermaidDiagram content="graph TD; A-->B;" isDark />
    </TooltipProvider>
  )
}

describe('ExpandableMermaidDiagram', () => {
  it('opens an accessible fullscreen diagram dialog from the expand control', async () => {
    const user = userEvent.setup()
    renderDiagram()

    const trigger = await screen.findByRole('button', { name: 'Expand diagram' })
    await user.click(trigger)
    const dialog = screen.getByRole('dialog', { name: 'Diagram' })
    expect(dialog).toBeTruthy()
    expect(screen.getAllByText('100%').length).toBeGreaterThan(0)
    expect(document.activeElement).toBe(dialog)

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Diagram' })).toBeNull())
    expect(document.activeElement).toBe(trigger)
  })

  it('zooms in from the dialog toolbar and can reset', async () => {
    renderDiagram()
    fireEvent.click(await screen.findByRole('button', { name: 'Expand diagram' }))

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    expect(screen.getByText('125%')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Reset zoom' }))
    expect(screen.getAllByText('100%').length).toBeGreaterThan(0)
  })

  it('closes from the dialog close button', async () => {
    renderDiagram()
    fireEvent.click(await screen.findByRole('button', { name: 'Expand diagram' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog', { name: 'Diagram' })).toBeNull()
  })
})
