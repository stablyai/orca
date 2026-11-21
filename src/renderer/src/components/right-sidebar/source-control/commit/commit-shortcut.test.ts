import type React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { handleSourceControlCommitShortcut } from './commit-shortcut'

function submitEvent(): React.KeyboardEvent<HTMLElement> {
  // The shortcut reads the platform from the user agent: Cmd on macOS, Ctrl elsewhere.
  const isMac = navigator.userAgent.includes('Mac')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler only reads key, modifier and composition fields and calls the two stubs.
  return {
    key: 'Enter',
    metaKey: isMac,
    ctrlKey: !isMac,
    altKey: false,
    shiftKey: false,
    nativeEvent: { isComposing: false },
    preventDefault: vi.fn(),
    stopPropagation: vi.fn()
  } as unknown as React.KeyboardEvent<HTMLElement>
}

describe('Cmd/Ctrl+Enter in Source Control', () => {
  it('still commits when the primary is Commit', () => {
    const onCommit = vi.fn()
    handleSourceControlCommitShortcut(submitEvent(), { kind: 'commit', disabled: false }, onCommit)
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it('does not open a review when the primary is the new Create PR face', () => {
    const onCommit = vi.fn()
    handleSourceControlCommitShortcut(
      submitEvent(),
      { kind: 'create_pr', disabled: false },
      onCommit
    )
    expect(onCommit).not.toHaveBeenCalled()
  })
})
