// @vitest-environment happy-dom
import { createRef } from 'react'
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { useTabBarQuickCommandSearchInput } from './use-tab-bar-quick-command-search-input'
import type { TerminalQuickCommand } from '../../../../shared/terminal-quick-command-types'

const command = { id: 'cmd-1', label: 'Run tests' } as unknown as TerminalQuickCommand

function setup(onRun = vi.fn()): {
  onRun: ReturnType<typeof vi.fn>
  result: ReturnType<typeof renderHook<ReturnType<typeof useTabBarQuickCommandSearchInput>, void>>
} {
  const result = renderHook(() =>
    useTabBarQuickCommandSearchInput({
      commandListRef: createRef<HTMLDivElement>(),
      commandValue: command.id,
      filteredCommands: [command],
      getCommandId: (item) => item.id,
      onCommandValueChange: () => {},
      onRun,
      selectedCommand: command
    })
  )
  return { onRun, result }
}

function keyEvent(init: {
  key: string
  keyCode: number
  ctrlKey?: boolean
  metaKey?: boolean
  shiftKey?: boolean
  altKey?: boolean
  isComposing?: boolean
  preventDefault?: () => void
  stopPropagation?: () => void
}): never {
  return {
    key: init.key,
    keyCode: init.keyCode,
    ctrlKey: init.ctrlKey ?? false,
    altKey: init.altKey ?? false,
    metaKey: init.metaKey ?? false,
    shiftKey: init.shiftKey ?? false,
    nativeEvent: { isComposing: init.isComposing ?? false },
    preventDefault: init.preventDefault ?? (() => {}),
    stopPropagation: init.stopPropagation ?? (() => {})
  } as never
}

// Why: Enter here RUNS a terminal command, so a stray Enter is not recoverable.
describe('useTabBarQuickCommandSearchInput IME Enter ownership', () => {
  it('navigates hosted commands by the caller-provided composite key', () => {
    const entries = [{ key: 'local\0shared' }, { key: 'runtime:build\0shared' }]
    const onCommandValueChange = vi.fn()
    const { result } = renderHook(() =>
      useTabBarQuickCommandSearchInput({
        commandListRef: createRef<HTMLDivElement>(),
        commandValue: entries[0].key,
        filteredCommands: entries,
        getCommandId: (entry) => entry.key,
        onCommandValueChange,
        onRun: vi.fn(),
        selectedCommand: entries[0]
      })
    )

    result.current.onKeyDown(keyEvent({ key: 'ArrowDown', keyCode: 40 }))

    expect(onCommandValueChange).toHaveBeenCalledWith(entries[1].key)
  })

  it('lets the native select-all behavior run in the search input', () => {
    const { result } = setup()
    const stopPropagation = vi.fn()
    const preventDefault = vi.fn()

    result.result.current.onKeyDown(
      keyEvent({
        key: 'a',
        keyCode: 65,
        ctrlKey: true,
        stopPropagation,
        preventDefault
      })
    )

    expect(stopPropagation).toHaveBeenCalledOnce()
    expect(preventDefault).not.toHaveBeenCalled()
  })

  it('does not run the command on the bare redispatch after a confirm', () => {
    const { onRun, result } = setup()
    result.result.current.onCompositionStart()
    result.result.current.onKeyDown(keyEvent({ key: 'Process', keyCode: 229, isComposing: true }))
    result.result.current.onCompositionEnd()
    result.result.current.onKeyDown(keyEvent({ key: 'Enter', keyCode: 13 }))

    expect(onRun).not.toHaveBeenCalled()
  })

  it('does not run the command on an Enter pressed during composition', () => {
    const { onRun, result } = setup()
    result.result.current.onCompositionStart()
    result.result.current.onKeyDown(keyEvent({ key: 'Enter', keyCode: 13, isComposing: true }))

    expect(onRun).not.toHaveBeenCalled()
  })

  // Regression: the carry token owned any modifier-carrying Enter, so a modifier held
  // through the confirm silently dropped the run. Ctrl, not Cmd: happy-dom is non-Mac.
  it('runs the command when a modifier is held through the confirm redispatch', () => {
    const { onRun, result } = setup()
    result.result.current.onCompositionStart()
    result.result.current.onKeyDown(
      keyEvent({ key: 'Enter', keyCode: 13, isComposing: true, ctrlKey: true })
    )
    result.result.current.onCompositionEnd()
    result.result.current.onKeyDown(keyEvent({ key: 'Enter', keyCode: 13, ctrlKey: true }))

    expect(onRun).toHaveBeenCalledWith(command)
  })

  it('runs the command on an ordinary Enter', () => {
    const { onRun, result } = setup()
    result.result.current.onKeyDown(keyEvent({ key: 'Enter', keyCode: 13 }))

    expect(onRun).toHaveBeenCalledWith(command)
  })
})
