// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireImeConfirmEnter, firePlainEnter } from '@/lib/ime-enter-confirm-test-fixture'
import { OpenInMenuSetting } from './OpenInMenuSetting'

afterEach(cleanup)

/** Asserts the IME-confirm Enter neither commits nor blurs, while a plain Enter commits and blurs. */
function expectEnterRespectsComposition(
  input: HTMLElement,
  updateSettings: ReturnType<typeof vi.fn>
): void {
  updateSettings.mockClear()
  act(() => input.focus())
  fireImeConfirmEnter(input)
  expect(document.activeElement).toBe(input)
  expect(updateSettings).not.toHaveBeenCalled()

  firePlainEnter(input)
  expect(document.activeElement).not.toBe(input)
  expect(updateSettings).toHaveBeenCalledWith({
    openInApplications: [{ id: 'app-1', label: 'My editor', command: 'myedit' }]
  })
}

describe('OpenInMenuSetting Enter', () => {
  it('keeps editing through the Enter that confirms an IME composition', () => {
    const updateSettings = vi.fn()
    render(
      <OpenInMenuSetting
        applications={[{ id: 'app-1', label: 'My editor', command: 'myedit' }]}
        updateSettings={updateSettings}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Edit app' }))

    expectEnterRespectsComposition(screen.getByPlaceholderText('App name'), updateSettings)
    expectEnterRespectsComposition(screen.getByDisplayValue('myedit'), updateSettings)
  })
})
