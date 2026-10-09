// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  exportBackup: vi.fn(),
  previewBackupImport: vi.fn(),
  applyBackupImport: vi.fn(),
  listRecoveryPoints: vi.fn(),
  restoreRecoveryPoint: vi.fn()
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, options?: Record<string, unknown>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(options?.[name] ?? ''))
}))

import { BackupRestorePane } from './BackupRestorePane'

describe('BackupRestorePane', () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) {
      fn.mockReset()
    }
    api.listRecoveryPoints.mockResolvedValue([])
    Object.defineProperty(window, 'api', { value: { settings: api }, configurable: true })
  })

  afterEach(() => {
    cleanup()
  })

  it('exports every section except device-specific settings by default', async () => {
    api.exportBackup.mockResolvedValue({
      status: 'saved',
      filePath: '/tmp/orca.orca-settings.json',
      exportedKeyCount: 42,
      excludedSecretKeys: []
    })
    render(<BackupRestorePane />)
    await userEvent.click(screen.getByRole('button', { name: /Export/ }))

    const sections: string[] = api.exportBackup.mock.calls[0][0].sections
    expect(sections).toContain('appearance')
    expect(sections).not.toContain('device')
    expect(
      await screen.findByText('Saved 42 settings to /tmp/orca.orca-settings.json.')
    ).toBeInTheDocument()
  })

  it('reviews an import and applies only the checked changes', async () => {
    api.previewBackupImport.mockResolvedValue({
      status: 'ready',
      previewId: 'preview-1',
      fileName: 'orca.orca-settings.json',
      createdAt: '2026-10-09T00:00:00.000Z',
      appVersion: '1.4.214',
      sourcePlatform: 'win32',
      sameAppVersion: true,
      newerAppVersion: false,
      sections: ['appearance', 'device'],
      entries: [
        {
          key: 'theme',
          section: 'appearance',
          kind: 'changed',
          currentValue: 'light',
          incomingValue: 'dark',
          applicable: true
        },
        {
          key: 'terminalWindowsShell',
          section: 'device',
          kind: 'changed',
          currentValue: 'powershell.exe',
          incomingValue: 'pwsh.exe',
          skipReason: 'other-platform',
          applicable: true
        },
        {
          key: 'opencodeSessionCookie',
          section: null,
          kind: 'changed',
          currentValue: undefined,
          incomingValue: undefined,
          skipReason: 'protected-key',
          applicable: false
        }
      ],
      unchangedKeyCount: 3
    })
    api.applyBackupImport.mockResolvedValue({
      status: 'applied',
      appliedKeys: ['theme'],
      recoveryPointId: 'point-1'
    })
    render(<BackupRestorePane />)
    await userEvent.click(screen.getByRole('button', { name: /Import/ }))

    expect(await screen.findByText('Not imported')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Apply 1 selected' }))

    expect(api.applyBackupImport).toHaveBeenCalledWith({ previewId: 'preview-1', keys: ['theme'] })
    await waitFor(() => expect(api.listRecoveryPoints).toHaveBeenCalledTimes(2))
    expect(await screen.findByText(/Imported 1 settings/)).toBeInTheDocument()
  })

  it('explains a damaged backup without opening the review', async () => {
    api.previewBackupImport.mockResolvedValue({
      status: 'invalid',
      reason: 'integrity-mismatch',
      message: 'ignored'
    })
    render(<BackupRestorePane />)
    await userEvent.click(screen.getByRole('button', { name: /Import/ }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/damaged or was edited/)
    expect(screen.queryByText('Review import')).not.toBeInTheDocument()
  })
})
