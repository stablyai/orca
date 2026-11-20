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

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'api')
})

describe('BotPicturePicker with its own intake', () => {
  it('keeps an upload being read when a Generate prompt is turned away', async () => {
    Reflect.set(window, 'api', {
      avatarGeneration: {
        capability: async () => ({ agents: [{ agent: 'codex', status: 'ready' }] }),
        generate: vi.fn(),
        cancel: async () => {}
      }
    })
    let finish: (png: string) => void = () => {}
    mocks.squareAvatarPng.mockImplementation(
      () => new Promise<string>((resolve) => (finish = resolve))
    )
    const onUpload = vi.fn()
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
    const input = document.querySelector('input[type="file"]')
    if (!input) {
      throw new Error('no file input')
    }
    fireEvent.change(input, {
      target: { files: [new File(['x'], 'me.png', { type: 'image/png' })] }
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Previous picture' }))
    const box = await screen.findByRole('textbox', { name: 'Picture description' })
    fireEvent.change(box, { target: { value: 'a picture of me' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(await screen.findByRole('alert')).toBeTruthy()

    finish('UE5H')
    await waitFor(() => expect(onUpload).toHaveBeenCalledWith('UE5H', 2))
  })
})
