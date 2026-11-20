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

function renderPicker(onUpload: (png: string, after: number) => void, onChange = vi.fn()) {
  Reflect.set(window, 'api', {
    avatarGeneration: {
      capability: async () => ({ agents: [{ agent: 'codex', status: 'ready' }] }),
      generate: vi.fn(),
      cancel: async () => {}
    }
  })
  render(
    <TooltipProvider>
      <BotPicturePicker
        value={{ kind: 'mascot', index: 2 }}
        custom={null}
        onChange={onChange}
        onUpload={onUpload}
      />
    </TooltipProvider>
  )
  return onChange
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
  it('drops an upload still being read once a mascot is chosen', async () => {
    const onUpload = vi.fn()
    const onChange = renderPicker(onUpload)
    await screen.findByRole('button', { name: 'Previous picture' })
    const finish = chooseSlowUpload()
    fireEvent.click(screen.getByRole('button', { name: 'Next picture' }))
    expect(onChange).toHaveBeenCalledWith({ kind: 'mascot', index: 3 })

    finish('U0xPVw')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(onUpload).not.toHaveBeenCalled()
  })

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
