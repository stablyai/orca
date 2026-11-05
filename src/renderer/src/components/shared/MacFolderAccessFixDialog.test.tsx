// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const { trackTelemetry, restart, openSettings, resetFolderAccess, dismissToast } = vi.hoisted(
  () => ({
    trackTelemetry: vi.fn(),
    restart: vi.fn(async () => ({ success: true })),
    openSettings: vi.fn(async () => {}),
    resetFolderAccess: vi.fn(),
    dismissToast: vi.fn()
  })
)

vi.mock('sonner', () => ({ toast: { dismiss: dismissToast } }))
vi.mock('@/lib/telemetry', () => ({ track: trackTelemetry }))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, options?: Record<string, string>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (match, name: string) => options?.[name] ?? match)
}))

import { MacFolderAccessFixDialog } from './MacFolderAccessFixDialog'
import {
  useMacFolderAccessFixStore,
  type FolderAccessNoticePhase
} from '@/store/mac-folder-access-fix'

const SCOPE = 'aaaa111122223333'

function noticePhase(): FolderAccessNoticePhase | undefined {
  return useMacFolderAccessFixStore.getState().noticePhaseByScope.get(SCOPE)
}

function openWith(
  freshDaemonAccess: 'allowed' | 'denied' | 'unknown',
  cwdClass: 'documents' | 'other-home' | 'outside-home' = 'documents'
): void {
  useMacFolderAccessFixStore.setState({
    mismatch: { daemonScope: SCOPE, cwdClass, freshDaemonAccess },
    openScope: SCOPE,
    noticePhaseByScope: new Map<string, FolderAccessNoticePhase>([[SCOPE, 'visible']])
  })
}

function dialogShown(): boolean {
  return screen.queryByRole('dialog') !== null
}

function resetButton(): HTMLElement {
  return screen.getByRole('button', { name: /^Reset/ })
}

function probed(freshDaemonAccess: 'allowed' | 'denied' | 'unknown'): void {
  resetFolderAccess.mockResolvedValue({
    outcome: 'probed',
    mismatch: { daemonScope: 'aaaa111122223333', cwdClass: 'documents', freshDaemonAccess }
  })
}

beforeEach(() => {
  trackTelemetry.mockReset()
  restart.mockReset().mockResolvedValue({ success: true })
  openSettings.mockReset().mockResolvedValue(undefined)
  resetFolderAccess.mockReset()
  dismissToast.mockReset()
  probed('denied')
  useMacFolderAccessFixStore.setState({
    mismatch: null,
    openScope: null,
    noticePhaseByScope: new Map<string, FolderAccessNoticePhase>()
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      pty: { management: { restart, resetFolderAccess } },
      developerPermissions: { openSettings }
    }
  })
})

afterEach(() => {
  cleanup()
})

describe('MacFolderAccessFixDialog', () => {
  it('closes when the reset finds the evidence gone', async () => {
    resetFolderAccess.mockResolvedValue({ outcome: 'probed', mismatch: null })
    openWith('denied')
    render(<MacFolderAccessFixDialog />)

    await userEvent.click(resetButton())

    await waitFor(() => {
      expect(dialogShown()).toBe(false)
    })
    expect(useMacFolderAccessFixStore.getState().mismatch).toBeNull()
    // The store must retire the toast separately because it outlives the dialog.
    expect(noticePhase()).toBe('retired')
    expect(dismissToast).toHaveBeenCalledWith('mac-daemon-folder-access-mismatch')
  })
})
