import { describe, expect, it, vi } from 'vitest'
import type { ConfirmationDialogOptions } from '@/components/confirmation-dialog-context'

import { sitePermissionPrompt } from './browser-site-permission-prompt'

const signal = new AbortController().signal
const details = {
  origin: 'https://meet.example.com',
  permissions: ['camera' as const, 'microphone' as const]
}

describe('browser site permission prompt', () => {
  it('names the site and lists what it wants', async () => {
    const confirm = vi.fn(async (_options: ConfirmationDialogOptions) => true)

    await expect(sitePermissionPrompt.ask(confirm, details, signal)).resolves.toBe('allow')
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'meet.example.com wants to',
        description: 'Use your camera\nUse your microphone',
        confirmLabel: 'Allow',
        cancelLabel: 'Block'
      })
    )
  })

  it('calls a local file "this file"', async () => {
    const confirm = vi.fn(async (_options: ConfirmationDialogOptions) => true)

    await sitePermissionPrompt.ask(confirm, { origin: 'file://', permissions: ['camera'] }, signal)
    expect(confirm.mock.calls[0][0].title).toBe('This file wants to')
  })

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
