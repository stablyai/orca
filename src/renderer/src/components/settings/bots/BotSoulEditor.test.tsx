// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { ConfirmationDialogOptions } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import {
  BotSettingsLeaveGuardContext,
  type BotSettingsLeaveGuards,
  createBotSettingsLeaveGuards
} from '@/components/bots/settings-view/bot-settings-leave-guard'

const { confirm } = vi.hoisted(() => ({
  confirm: vi.fn(async (_options: ConfirmationDialogOptions) => true)
}))
vi.mock('@/components/dismiss/confirmation/confirmation-dialog-context', () => ({
  useConfirmationDialog: () => confirm
}))

import { BotSoulEditor } from './BotSoulEditor'
import type { BotHomeFile, BotHomeFileWrite } from './use-bot-home-file'

afterEach(() => {
  cleanup()
  confirm.mockClear()
})

function file(
  disk: string,
  write: BotHomeFile['write'] = vi.fn(async (): Promise<BotHomeFileWrite> => 'saved')
): BotHomeFile & { disk: string } {
  return { disk, readError: null, refresh: vi.fn(async () => {}), write }
}

describe('BotSoulEditor', () => {
  it('keeps typing done while a save is in flight', async () => {
    let finish: (value: BotHomeFileWrite) => void = () => {}
    const write = vi.fn(() => new Promise<BotHomeFileWrite>((resolve) => (finish = resolve)))
    const { getByLabelText, rerender } = render(
      <BotSoulEditor file={file('a', write)} label="Soul" />
    )
    const editor = getByLabelText('Soul')
    fireEvent.change(editor, { target: { value: 'ab' } })
    fireEvent.blur(editor)
    fireEvent.change(editor, { target: { value: 'abc' } })
    // The hook reports its own write as the new disk text.
    rerender(<BotSoulEditor file={file('ab', write)} label="Soul" />)
    finish('saved')
    await waitFor(() => expect(write).toHaveBeenCalledTimes(1))
    expect(getByLabelText('Soul')).toHaveProperty('value', 'abc')
  })

  it('builds a second save on the first while it is in flight', async () => {
    let finish: (value: BotHomeFileWrite) => void = () => {}
    const write = vi.fn(() => new Promise<BotHomeFileWrite>((resolve) => (finish = resolve)))
    const { getByLabelText } = render(<BotSoulEditor file={file('a', write)} label="Soul" />)
    const editor = getByLabelText('Soul')
    fireEvent.change(editor, { target: { value: 'ab' } })
    fireEvent.blur(editor)
    fireEvent.change(editor, { target: { value: 'abc' } })
    fireEvent.blur(editor)
    expect(write.mock.calls).toEqual([
      ['ab', 'a'],
      ['abc', 'ab']
    ])
    finish('saved')
  })

  it('saves a revert made while the edit it undoes is still saving', () => {
    const write = vi.fn(() => new Promise<BotHomeFileWrite>(() => {}))
    const { getByLabelText } = render(<BotSoulEditor file={file('a', write)} label="Soul" />)
    const editor = getByLabelText('Soul')
    fireEvent.change(editor, { target: { value: 'ab' } })
    fireEvent.blur(editor)
    fireEvent.change(editor, { target: { value: 'a' } })
    fireEvent.blur(editor)
    expect(write).toHaveBeenLastCalledWith('a', 'ab')
  })

  it('saves an unsaved edit when Settings closes without a blur', () => {
    const soul = file('old')
    const { getByLabelText, unmount } = render(<BotSoulEditor file={soul} label="Soul" />)
    fireEvent.change(getByLabelText('Soul'), { target: { value: 'new' } })
    unmount()
    expect(soul.write).toHaveBeenCalledWith('new', 'old')
  })

  it('does not write when nothing changed', () => {
    const soul = file('# Reviewer\n')
    const { getByLabelText } = render(<BotSoulEditor file={soul} label="Soul" />)
    fireEvent.blur(getByLabelText('Soul'))
    expect(soul.write).not.toHaveBeenCalled()
  })

  it('follows the disk while there is no unsaved edit', () => {
    const { getByLabelText, rerender, queryByRole } = render(
      <BotSoulEditor file={file('old')} label="Soul" />
    )
    rerender(<BotSoulEditor file={file('the bot wrote this')} label="Soul" />)
    expect(getByLabelText('Soul')).toHaveProperty('value', 'the bot wrote this')
    expect(queryByRole('alert')).toBeNull()
  })

  it('says so when the file changed under an unsaved edit, and keeps either side', async () => {
    const write = vi.fn(async (): Promise<BotHomeFileWrite> => 'saved')
    const { getByLabelText, getByRole, rerender, queryByRole } = render(
      <BotSoulEditor file={file('old', write)} label="Soul" />
    )
    fireEvent.change(getByLabelText('Soul'), { target: { value: 'mine' } })
    rerender(<BotSoulEditor file={file('theirs', write)} label="Soul" />)
    expect(getByRole('alert').textContent).toContain('SOUL.md changed on disk.')
    // Blur must not overwrite the bot's change unasked.
    fireEvent.blur(getByLabelText('Soul'))
    expect(write).not.toHaveBeenCalled()

    fireEvent.click(getByRole('button', { name: 'Keep mine' }))
    await waitFor(() => expect(write).toHaveBeenCalledWith('mine', 'theirs'))
    await waitFor(() => expect(queryByRole('alert')).toBeNull())
  })

  it('takes the disk text on Use theirs', () => {
    const { getByLabelText, getByRole, rerender, queryByRole } = render(
      <BotSoulEditor file={file('old')} label="Soul" />
    )
    fireEvent.change(getByLabelText('Soul'), { target: { value: 'mine' } })
    rerender(<BotSoulEditor file={file('theirs')} label="Soul" />)
    fireEvent.click(getByRole('button', { name: 'Use theirs' }))
    expect(getByLabelText('Soul')).toHaveProperty('value', 'theirs')
    expect(queryByRole('alert')).toBeNull()
  })

  describe('leaving its settings page during a conflict', () => {
    function inView(guards: BotSettingsLeaveGuards, soul: BotHomeFile & { disk: string }) {
      return (
        <BotSettingsLeaveGuardContext.Provider value={guards}>
          <BotSoulEditor file={soul} label="Soul" />
        </BotSettingsLeaveGuardContext.Provider>
      )
    }

    function conflicted(write: BotHomeFile['write']) {
      const guards = createBotSettingsLeaveGuards()
      const view = render(inView(guards, file('old', write)))
      fireEvent.change(view.getByLabelText('Soul'), { target: { value: 'mine' } })
      view.rerender(inView(guards, file('theirs', write)))
      return { guards, view }
    }

    it('keeps the draft on Keep mine, then leaves', async () => {
      const write = vi.fn(async (): Promise<BotHomeFileWrite> => 'saved')
      const { guards } = conflicted(write)
      confirm.mockResolvedValueOnce(true)
      let left = false
      await act(async () => {
        left = await guards.ask()
      })
      expect(confirm.mock.calls[0]?.[0]).toMatchObject({
        title: 'SOUL.md changed on disk.',
        confirmLabel: 'Keep mine',
        cancelLabel: 'Use theirs'
      })
      expect(write).toHaveBeenCalledWith('mine', 'theirs')
      expect(left).toBe(true)
    })

    it('stays when the prompt is dismissed', async () => {
      const write = vi.fn(async (): Promise<BotHomeFileWrite> => 'saved')
      const { guards, view } = conflicted(write)
      confirm.mockResolvedValueOnce(false)
      let left = true
      await act(async () => {
        left = await guards.ask()
      })
      expect(left).toBe(false)
      expect(write).not.toHaveBeenCalled()
      expect(view.getByLabelText('Soul')).toHaveProperty('value', 'mine')
    })
  })
})
