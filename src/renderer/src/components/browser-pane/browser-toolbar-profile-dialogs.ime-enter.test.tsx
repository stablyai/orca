// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  dispatchOrdinaryImplicitSubmit,
  dispatchRecordedImeImplicitSubmit
} from '../ime-enter-guarded-form.test-events'
import { BrowserToolbarProfileDialogs } from './browser-toolbar-profile-dialogs'

function renderDialogs(onCreateProfile: () => void): HTMLInputElement {
  render(
    <BrowserToolbarProfileDialogs
      pendingSwitchProfileId={undefined}
      onPendingSwitchChange={() => {}}
      onConfirmSwitch={() => {}}
      newProfileDialogOpen
      onNewProfileDialogOpenChange={() => {}}
      newProfileName="한국 프로필"
      onNewProfileNameChange={() => {}}
      isCreatingProfile={false}
      useNativeUserAgent={false}
      onUseNativeUserAgentChange={() => {}}
      onCreateProfile={onCreateProfile}
      onCancelNewProfile={() => {}}
    />
  )
  return screen.getByPlaceholderText('Profile name') as HTMLInputElement
}

afterEach(cleanup)

describe('BrowserToolbarProfileDialogs IME implicit submit', () => {
  it('does not create a browser profile on the recorded Korean Enter redispatch', () => {
    const onCreateProfile = vi.fn()
    const input = renderDialogs(onCreateProfile)

    expect(dispatchRecordedImeImplicitSubmit(input)).toBe(true)
    expect(onCreateProfile).not.toHaveBeenCalled()
  })

  it('creates a browser profile exactly once on an ordinary Enter', () => {
    const onCreateProfile = vi.fn()
    const input = renderDialogs(onCreateProfile)

    expect(dispatchOrdinaryImplicitSubmit(input)).toBe(false)
    expect(onCreateProfile).toHaveBeenCalledOnce()
  })
})
