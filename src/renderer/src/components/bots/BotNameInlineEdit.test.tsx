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
  const field = screen.getByRole('textbox', { name: 'Bot name' })
  if (!(field instanceof HTMLInputElement)) {
    throw new Error('not an input')
  }
  return field
}

async function press(field: HTMLInputElement, key: string): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(field, { key })
    fireEvent.blur(field)
  })
}

describe('BotNameInlineEdit', () => {
  afterEach(cleanup)

  it('Enter saves the trimmed name through the bot update', async () => {
    const update = vi.fn(async () => ({ ...bot, name: 'Release bot' }))
    const field = edit(update)
    fireEvent.change(field, { target: { value: '  Release bot ' } })
    await press(field, 'Enter')
    expect(update).toHaveBeenCalledWith({ name: 'Release bot' })
    expect(screen.queryByRole('textbox')).toBeNull()
  })

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
    expect(screen.getByRole('button', { name: 'Rename Bot builder' })).toBeTruthy()
  })

  it('an empty name is refused and the saved name stays', async () => {
    const update = vi.fn(async () => bot)
    const field = edit(update)
    fireEvent.change(field, { target: { value: '   ' } })
    await press(field, 'Enter')
    expect(update).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Rename Bot builder' }).textContent).toBe(
      'Bot builder'
    )
  })

  it('a name the bot update refuses leaves the field for the saved name', async () => {
    const update = vi.fn(async () => null)
    const field = edit(update)
    fireEvent.change(field, { target: { value: 'Taken name' } })
    await press(field, 'Enter')
    expect(update).toHaveBeenCalledWith({ name: 'Taken name' })
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getByRole('button', { name: 'Rename Bot builder' })).toBeTruthy()
  })

  it('focus moved on while the name saves stays where it went', async () => {
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
    fireEvent.change(field, { target: { value: 'Release bot' } })
    await press(field, 'Enter')
    const next = screen.getByRole('button', { name: 'Next' })
    next.focus()
    await act(async () => finish({ ...bot, name: 'Release bot' }))
    expect(document.activeElement).toBe(next)
  })

  it('Escape puts focus back on the name', async () => {
    const field = edit(vi.fn(async () => bot))
    await press(field, 'Escape')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Rename Bot builder' }))
  })
})
