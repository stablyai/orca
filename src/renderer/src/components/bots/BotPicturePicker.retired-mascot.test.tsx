// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { BotPicturePicker } from './BotPicturePicker'
import { readAvatarCapability, refreshAvatarCapability } from './avatar-generation-capability-store'

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'api')
})

describe('BotPicturePicker on a retired mascot', () => {
  it('keeps the bot on S2 and lets it wear an outfit', async () => {
    // A ready agent, so the picker has a Generate face to seed.
    Reflect.set(window, 'api', {
      avatarGeneration: {
        capability: async () => ({ agents: [{ agent: 'codex', status: 'ready' }] })
      }
    })
    refreshAvatarCapability()
    await waitFor(() => expect(readAvatarCapability()).toHaveLength(1))
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
    expect(document.querySelector('[data-face="generate"] img')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Outfit' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Tie' }))

    expect(onOutfitChange).toHaveBeenCalledWith('tie')
    expect(onChange).not.toHaveBeenCalled()
  })
})
