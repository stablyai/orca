// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentCommandOverrideInput, AgentDefaultArgsInput } from './AgentLaunchDefaultsEditor'
import { TooltipProvider } from '../ui/tooltip'

afterEach(cleanup)

it.each(['', '--default'])(
  'hides the %j placeholder while a permission chip is present',
  (defaultArgs) => {
    const editor = (withChip: boolean) => (
      <TooltipProvider>
        <AgentDefaultArgsInput
          defaultArgs={defaultArgs}
          argsOverride=""
          onSaveArgs={vi.fn()}
          choiceChips={
            withChip
              ? [
                  {
                    key: 'permissionMode',
                    label: 'Claude',
                    flag: '--permission-mode default',
                    onRemove: (text) => text
                  }
                ]
              : undefined
          }
        />
      </TooltipProvider>
    )
    const view = render(editor(true))
    expect(screen.getByRole('button', { name: /Remove --permission-mode default/ })).toBeDefined()
    const input = screen.getByRole('textbox', { name: 'Arguments' })
    expect(input).toHaveProperty('placeholder', '')
    expect(input).toHaveProperty('value', '')
    view.rerender(editor(false))
    expect(input).toHaveProperty('placeholder', defaultArgs || 'No default arguments')
  }
)

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
      const defaults = { defaultArgs: '--default', argsOverride: '--default', onSaveArgs: save }
      const view = render(
        field === 'arguments' ? (
          <AgentDefaultArgsInput {...defaults} argsOverride="--custom" />
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
      await user.type(input, ' dirty')
      await user.click(screen.getByRole('button', { name: 'Reset' }))
      expect(save).toHaveBeenNthCalledWith(
        1,
        field === 'arguments' ? '--custom dirty' : '/host/custom dirty'
      )
      finishBlur()
      await waitFor(() =>
        expect(save).toHaveBeenLastCalledWith(field === 'arguments' ? '--default' : '')
      )
      if (field === 'arguments') {
        view.rerender(<AgentDefaultArgsInput {...defaults} />)
      }
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
