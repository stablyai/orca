// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

import { renderCodexResetConfirmDialog } from './codex-reset-confirm-dialog'

// Why: the reset item calls preventDefault() in onSelect, so ProviderDetailsMenu
// stays mounted at z-70 (see ui/dropdown-menu.tsx) while this confirm is open.
const DROPDOWN_MENU_Z_INDEX = 70

function zIndexOf(element: Element | null): number {
  const match = /z-\[(\d+)\]/.exec(element?.className ?? '')
  return match ? Number(match[1]) : Number.NaN
}

describe('codex reset confirm stacking', () => {
  afterEach(() => {
    cleanup()
  })

  it('paints above the dropdown that stays open behind it', () => {
    render(
      renderCodexResetConfirmDialog({
        open: true,
        setOpen: vi.fn(),
        skipFutureResetConfirm: false,
        setSkipFutureResetConfirm: vi.fn(),
        isRedeemingReset: false,
        handleConfirmReset: vi.fn(async () => {})
      })
    )

    expect(zIndexOf(document.querySelector('[data-slot="dialog-overlay"]'))).toBeGreaterThan(
      DROPDOWN_MENU_Z_INDEX
    )
    expect(zIndexOf(document.querySelector('[data-slot="dialog-content"]'))).toBeGreaterThan(
      DROPDOWN_MENU_Z_INDEX
    )
  })
})
