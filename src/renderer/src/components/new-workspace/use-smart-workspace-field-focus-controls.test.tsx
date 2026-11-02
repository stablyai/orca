// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { expect, it } from 'vitest'
import { useSmartWorkspaceFieldFocusControls } from './use-smart-workspace-field-focus-controls'

it.each(['disabled', 'text', 'cross-repository'] as const)(
  'keeps a suspended %s source popover closed when the field resumes',
  (reason) => {
    let suspended = false
    const { result, rerender } = renderHook(() =>
      useSmartWorkspaceFieldFocusControls({
        props: { selectedSource: null, disabled: suspended && reason === 'disabled' },
        state: {
          mode: suspended && reason === 'text' ? 'text' : 'smart',
          crossRepoPrompt: suspended && reason === 'cross-repository'
        }
      })
    )
    act(() => {
      result.current.markSourcePopoverUserEngaged()
      result.current.setOpen(true)
    })
    expect(result.current.open).toBe(true)
    suspended = true
    rerender()
    expect(result.current.open).toBe(false)
    suspended = false
    rerender()
    expect(result.current.open).toBe(false)
  }
)
