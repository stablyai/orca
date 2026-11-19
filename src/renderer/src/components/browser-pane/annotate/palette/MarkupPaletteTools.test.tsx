// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { MarkupPaletteTools } from './MarkupPaletteTools'

afterEach(() => cleanup())

function renderTools(state: { canUndo: boolean; canRedo: boolean; canClear: boolean }) {
  return render(
    <TooltipProvider>
      <MarkupPaletteTools
        tool="pen"
        onToolChange={() => {}}
        color="#ef4444"
        onColorChange={() => {}}
        width={4}
        onWidthChange={() => {}}
        fontSize={16}
        onFontSizeChange={() => {}}
        onUndo={() => {}}
        onRedo={() => {}}
        onClear={() => {}}
        {...state}
      />
    </TooltipProvider>
  )
}

describe("Draw's Clear in the palette", () => {
  it('is unavailable on an empty canvas, even when Redo could bring strokes back', () => {
    renderTools({ canUndo: false, canRedo: true, canClear: false })

    expect(screen.getByRole('button', { name: 'Clear all' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: 'Redo' }).hasAttribute('disabled')).toBe(false)
  })

  it('is available while there are strokes', () => {
    renderTools({ canUndo: true, canRedo: false, canClear: true })

    expect(screen.getByRole('button', { name: 'Clear all' }).hasAttribute('disabled')).toBe(false)
  })
})
