import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess }
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

import { persistConfirmationSkipPreference } from './confirmation-skip-preference'

function deferred(): {
  promise: Promise<void>
  reject: (error: Error) => void
  resolve: () => void
} {
  let reject!: (error: Error) => void
  let resolve!: () => void
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, reject, resolve }
}

function persist(updateSettings: () => Promise<void>): void {
  persistConfirmationSkipPreference({
    updates: { skipDeleteArtifactConfirm: true },
    settingsSectionId: 'artifact-confirmation',
    updateSettings,
    openSettingsPage: vi.fn(),
    openSettingsTarget: vi.fn()
  })
}

describe('persistConfirmationSkipPreference', () => {
  beforeEach(() => {
    mocks.toastError.mockReset()
    mocks.toastSuccess.mockReset()
  })

  it('shows success only after the preference is persisted', async () => {
    const write = deferred()
    persist(() => write.promise)

    expect(mocks.toastSuccess).not.toHaveBeenCalled()
    write.resolve()

    await vi.waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledOnce())
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('reports a failed preference write without claiming success', async () => {
    const write = deferred()
    persist(() => write.promise)
    write.reject(new Error('write failed'))

    await vi.waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith('Could not save the confirmation preference.')
    )
    expect(mocks.toastSuccess).not.toHaveBeenCalled()
  })
})
