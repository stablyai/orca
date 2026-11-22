// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { BotPicturePicker } from './BotPicturePicker'

afterEach(() => {
  cleanup()
})

describe('BotPicturePicker on a retired mascot', () => {
  it('keeps the bot on S2 and lets it wear an outfit', async () => {
    const onChange = vi.fn()
    const onOutfitChange = vi.fn()
    render(
      <TooltipProvider>
        <BotPicturePicker
          value={{ kind: 'custom' }}
          custom={{
            src: 'data:image/svg+xml,S2',
            fallback: '',
            after: 4,
            description: 'Current picture',
            mascot: 'S2'
          }}
          onChange={onChange}
          onUpload={() => {}}
          color="#f4c4cf"
          onColorChange={() => {}}
          outfit={null}
          onOutfitChange={onOutfitChange}
        />
      </TooltipProvider>
    )
    expect(document.querySelector('[data-position="current"]')?.getAttribute('data-face')).toBe(
      'custom'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Outfit' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Tie' }))

    expect(onOutfitChange).toHaveBeenCalledWith('tie')
    expect(onChange).not.toHaveBeenCalled()
  })
})
