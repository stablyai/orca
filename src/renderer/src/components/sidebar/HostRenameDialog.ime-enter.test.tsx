// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireImeConfirmEnter, firePlainEnter } from '@/lib/ime-enter-confirm-test-fixture'

const updateSettings = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({ settings: { hostSettingOverrides: {} }, updateSettings })
}))

import { HostRenameDialog } from './HostRenameDialog'

afterEach(() => {
  cleanup()
  updateSettings.mockClear()
})

describe('HostRenameDialog Enter', () => {
  it('ignores the Enter that confirms an IME composition and submits on a plain Enter', () => {
    const onOpenChange = vi.fn()
    render(
      <HostRenameDialog open onOpenChange={onOpenChange} hostId="local" derivedLabel="This Mac" />
    )
    const input = screen.getByPlaceholderText('This Mac')

    fireImeConfirmEnter(input)
    expect(updateSettings).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalled()

    firePlainEnter(input)
    expect(updateSettings).toHaveBeenCalledTimes(1)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('ignores the unmarked Enter when keyup arrives first, as on macOS', () => {
    // Hold the frame so the carry is still armed, matching a same-frame redispatch.
    vi.stubGlobal('requestAnimationFrame', () => 0)
    try {
      const onOpenChange = vi.fn()
      render(
        <HostRenameDialog open onOpenChange={onOpenChange} hostId="local" derivedLabel="This Mac" />
      )
      const input = screen.getByPlaceholderText('This Mac')

      fireEvent.compositionStart(input)
      fireEvent.keyDown(input, { key: 'Enter', keyCode: 229, isComposing: true })
      fireEvent.compositionEnd(input)
      fireEvent.keyUp(input, { key: 'Enter', keyCode: 13 })
      fireEvent.keyDown(input, { key: 'Enter', keyCode: 13 })

      expect(updateSettings).not.toHaveBeenCalled()
      expect(onOpenChange).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
