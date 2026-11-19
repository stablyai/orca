// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../shared/bot-types'
import { BotNameInlineEdit } from './BotNameInlineEdit'

const bot: Bot = {
  id: 'bot-1',
  name: 'Bot builder',
  hostId: 'local',
  folder: 'bot-builder',
  folderWorkspaceId: 'home-1',
  agent: 'claude',
  avatar: null,
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  linear: null,
  github: null,
  chatSessionId: null,
  createdAt: 1,
  updatedAt: 1
}

function edit(update: (updates: { name?: string }) => Promise<Bot | null>): HTMLInputElement {
  render(<BotNameInlineEdit bot={bot} update={update} className="" />)
  fireEvent.click(screen.getByRole('button', { name: 'Rename Bot builder' }))
  return screen.getByRole<HTMLInputElement>('textbox', { name: 'Bot name' })
}

async function press(field: HTMLInputElement, key: string): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(field, { key })
    fireEvent.blur(field)
  })
}

describe('BotNameInlineEdit', () => {
  afterEach(cleanup)

  it('leaving the field saves too', async () => {
    const update = vi.fn(async () => ({ ...bot, name: 'Release bot' }))
    const field = edit(update)
    fireEvent.change(field, { target: { value: 'Release bot' } })
    await act(async () => {
      fireEvent.blur(field)
    })
    expect(update).toHaveBeenCalledWith({ name: 'Release bot' })
  })

  it('Escape cancels without saving, and its field blur does not save', async () => {
    const update = vi.fn(async () => bot)
    const field = edit(update)
    fireEvent.change(field, { target: { value: 'Release bot' } })
    await press(field, 'Escape')
    expect(update).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Rename Bot builder' }))
  })

  it('keeps the saved name after blank input or a refusal from the host', async () => {
    const update = vi.fn(async () => null)
    const field = edit(update)
    fireEvent.change(field, { target: { value: '   ' } })
    await press(field, 'Enter')
    expect(update).not.toHaveBeenCalled()

    const saved = screen.getByRole('button', { name: 'Rename Bot builder' })
    expect(saved.textContent).toBe('Bot builder')
    fireEvent.click(saved)
    const retry = screen.getByRole<HTMLInputElement>('textbox', { name: 'Bot name' })
    fireEvent.change(retry, { target: { value: 'Taken name' } })
    await act(async () => fireEvent.keyDown(retry, { key: 'Enter' }))
    expect(update).toHaveBeenCalledExactlyOnceWith({ name: 'Taken name' })
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getByRole('button', { name: 'Rename Bot builder' })).toBeTruthy()
  })

  it('Enter saves the trimmed name without taking focus back when the write finishes', async () => {
    let finish: (saved: Bot) => void = () => {}
    const update = vi.fn(
      () =>
        new Promise<Bot | null>((resolve) => {
          finish = resolve
        })
    )
    render(
      <>
        <BotNameInlineEdit bot={bot} update={update} className="" />
        <button type="button">Next</button>
      </>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Rename Bot builder' }))
    const field = screen.getByRole('textbox', { name: 'Bot name' })
    if (!(field instanceof HTMLInputElement)) {
      throw new Error('not an input')
    }
    fireEvent.change(field, { target: { value: '  Release bot ' } })
    await act(async () => {
      fireEvent.keyDown(field, { key: 'Enter' })
    })
    expect(update).toHaveBeenCalledExactlyOnceWith({ name: 'Release bot' })
    const next = screen.getByRole('button', { name: 'Next' })
    next.focus()
    await act(async () => finish({ ...bot, name: 'Release bot' }))
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(document.activeElement).toBe(next)
  })
})
