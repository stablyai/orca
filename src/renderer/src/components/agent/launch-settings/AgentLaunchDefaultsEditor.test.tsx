// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentDefaultArgsInput } from './AgentLaunchDefaultsEditor'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('launch field reset ordering', () => {
  it.each(['resolved', 'rejected'] as const)(
    'coalesces duplicate saves and resets after the blur save is %s',
    async (result) => {
      let finishBlur!: () => void
      let rejectBlur!: (error: Error) => void
      let rejectReset!: (error: Error) => void
      let finishReset!: () => void
      const blurSave = new Promise<void>((resolve, reject) => {
        finishBlur = resolve
        rejectBlur = reject
      })
      const resetSave = new Promise<void>((resolve, reject) => {
        rejectReset = reject
        finishReset = resolve
      })
      const save = vi.fn().mockReturnValueOnce(blurSave).mockReturnValueOnce(resetSave)
      const user = userEvent.setup()
      const defaults = { defaultArgs: '--default', onSaveArgs: save }
      const editor = (argsOverride: string) => (
        <AgentDefaultArgsInput {...defaults} argsOverride={argsOverride} />
      )
      const view = render(editor('--custom'))
      const input = screen.getByRole('textbox')
      await user.click(input)
      await user.type(input, ' dirty')
      await user.click(screen.getByRole('button', { name: 'Reset' }))
      await user.click(screen.getByRole('button', { name: 'Reset' }))
      expect(save).toHaveBeenCalledTimes(1)
      if (result === 'rejected') {
        rejectBlur(new Error('disconnected'))
      } else {
        finishBlur()
      }
      await waitFor(() => expect(save).toHaveBeenNthCalledWith(2, '--default'))
      expect(input).toHaveProperty('readOnly', true)
      view.rerender(editor('--custom dirty'))
      await user.click(input)
      await user.tab()
      view.rerender(editor('--default'))
      expect(input).toHaveProperty('value', '--custom dirty')
      if (result === 'rejected') {
        rejectReset(new Error('unknown acknowledgement'))
        await waitFor(() => expect(input).toHaveProperty('readOnly', false))
        expect(input).toHaveProperty('value', '--custom dirty')
        await user.click(screen.getByRole('button', { name: 'Reset' }))
      } else {
        finishReset()
      }
      await waitFor(() => expect(input).toHaveProperty('readOnly', false))
      expect(input).toHaveProperty('value', '--default')
      expect(save).toHaveBeenCalledTimes(result === 'rejected' ? 3 : 2)
    }
  )
})
