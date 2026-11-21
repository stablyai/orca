// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'

const mocks = vi.hoisted(() => ({ squareAvatarPng: vi.fn() }))
vi.mock('./bot-avatar-upload', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  squareAvatarPng: mocks.squareAvatarPng
}))

import { BotPicturePicker } from './BotPicturePicker'
import {
  resetAvatarCapabilityForTest,
  seedAvatarCapabilityForTest
} from './avatar-generation-capability-store'

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'api')
  resetAvatarCapabilityForTest()
})

function renderPicker(onUpload: (png: string, after: number) => void): void {
  Reflect.set(window, 'api', {
    avatarGeneration: {
      capability: async () => ({ agents: [{ agent: 'codex', status: 'ready' }] }),
      generate: vi.fn(),
      cancel: async () => {}
    }
  })
  seedAvatarCapabilityForTest([{ agent: 'codex', status: 'ready' }])
  render(
    <TooltipProvider>
      <BotPicturePicker
        value={{ kind: 'mascot', index: 2 }}
        custom={null}
        onChange={() => {}}
        onUpload={onUpload}
      />
    </TooltipProvider>
  )
}

function chooseSlowUpload(): (png: string) => void {
  let finish: (png: string) => void = () => {}
  mocks.squareAvatarPng.mockImplementation(
    () => new Promise<string>((resolve) => (finish = resolve))
  )
  const input = document.querySelector('input[type="file"]')
  if (!input) {
    throw new Error('no file input')
  }
  fireEvent.change(input, {
    target: { files: [new File(['x'], 'me.png', { type: 'image/png' })] }
  })
  return (png) => finish(png)
}

describe('BotPicturePicker with its own intake', () => {
  it('lands an upload still being read when only the empty Generate face was browsed', async () => {
    const onUpload = vi.fn()
    renderPicker(onUpload)
    await screen.findByRole('button', { name: 'Previous picture' })
    const finish = chooseSlowUpload()
    fireEvent.click(screen.getByRole('button', { name: 'Previous picture' }))
    await screen.findByRole('textbox', { name: 'Picture description' })

    finish('U0xPVw')
    await waitFor(() => expect(onUpload).toHaveBeenCalledWith('U0xPVw', 2))
  })
})

describe('BotPicturePicker on a retired mascot', () => {
  it('keeps the bot on S2 and lets it wear an outfit', async () => {
    seedAvatarCapabilityForTest([{ agent: 'codex', status: 'ready' }])
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
