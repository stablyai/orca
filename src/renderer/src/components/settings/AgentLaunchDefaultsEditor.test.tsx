// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentCommandOverrideInput, AgentDefaultArgsInput } from './AgentLaunchDefaultsEditor'

afterEach(cleanup)

describe('launch field reset ordering', () => {
  it.each(['arguments', 'command'] as const)(
    'honors the first Reset click after blurring a focused %s field',
    async (field) => {
      let finishBlur!: () => void
      const blurSave = new Promise<void>((resolve) => {
        finishBlur = resolve
      })
      const save = vi.fn().mockResolvedValue(undefined).mockReturnValueOnce(blurSave)
      const user = userEvent.setup()
      render(
        field === 'arguments' ? (
          <AgentDefaultArgsInput
            defaultArgs="--default"
            argsOverride="--custom"
            onSaveArgs={save}
          />
        ) : (
          <AgentCommandOverrideInput
            defaultCmd="claude"
            cmdOverride="/host/custom"
            onSaveOverride={save}
          />
        )
      )
      const input = screen.getByRole('textbox')
      await user.click(input)
      await user.click(screen.getByRole('button', { name: 'Reset' }))
      expect(save).toHaveBeenNthCalledWith(1, field === 'arguments' ? '--custom' : '/host/custom')
      finishBlur()
      await waitFor(() =>
        expect(save).toHaveBeenLastCalledWith(field === 'arguments' ? '--default' : '')
      )
      await waitFor(() =>
        expect(input).toHaveProperty('value', field === 'arguments' ? '--default' : 'claude')
      )
      expect(save).toHaveBeenCalledTimes(2)
    }
  )

  it.each(['resolved', 'rejected'] as const)(
    'coalesces duplicate saves and resets after the blur save is %s',
    async (result) => {
      let finishBlur!: () => void
      let rejectBlur!: (error: Error) => void
      let finishReset!: () => void
      const blurSave = new Promise<void>((resolve, reject) => {
        finishBlur = resolve
        rejectBlur = reject
      })
      const resetSave = new Promise<void>((resolve) => {
        finishReset = resolve
      })
      const save = vi.fn().mockReturnValueOnce(blurSave).mockReturnValueOnce(resetSave)
      const user = userEvent.setup()
      render(
        <AgentDefaultArgsInput defaultArgs="--default" argsOverride="--custom" onSaveArgs={save} />
      )
      const input = screen.getByRole('textbox')
      await user.click(input)
      await user.keyboard('{Enter}')
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
      finishReset()
      await waitFor(() => expect(input).toHaveProperty('readOnly', false))
      expect(input).toHaveProperty('value', '--default')
      expect(save).toHaveBeenCalledTimes(2)
    }
  )
})
