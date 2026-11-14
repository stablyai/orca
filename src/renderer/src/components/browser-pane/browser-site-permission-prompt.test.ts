import { describe, expect, it, vi } from 'vitest'
import type { ConfirmationDialogOptions } from '@/components/confirmation-dialog-context'

import { sitePermissionPrompt } from './browser-site-permission-prompt'

const signal = new AbortController().signal
const details = {
  origin: 'https://meet.example.com',
  permissions: ['camera' as const, 'microphone' as const]
}

describe('browser site permission prompt', () => {
  // Stands in for the dialog: Block runs onCancelClicked before resolving false; Esc only resolves.
  it.each([
    ['Block', true, 'block'],
    ['a dismissal', false, null]
  ])('answers %s with %s', async (_name, pressedBlock, expected) => {
    const confirm = vi.fn(async (options: ConfirmationDialogOptions) => {
      if (pressedBlock) {
        options.onCancelClicked?.()
      }
      return false
    })

    await expect(sitePermissionPrompt.ask(confirm, details, signal)).resolves.toBe(expected)
  })
})
