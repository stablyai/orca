// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DataRecoveryMigrationNotice } from './DataRecoveryMigrationNotice'

const mocks = vi.hoisted(() => ({
  writeClipboardText: vi.fn(async () => {}),
  toastSuccess: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError }
}))

type ApiStub = {
  migrationStatus: ReturnType<typeof vi.fn>
  retryAgentCatalogMigration: ReturnType<typeof vi.fn>
  listPoints: ReturnType<typeof vi.fn>
  restore: ReturnType<typeof vi.fn>
}

function installApi(overrides: Partial<ApiStub> = {}): ApiStub {
  const api: ApiStub = {
    migrationStatus: vi.fn().mockResolvedValue({ agentCatalogMigrationError: 'disk full' }),
    retryAgentCatalogMigration: vi.fn().mockResolvedValue({ ok: true }),
    listPoints: vi.fn().mockResolvedValue([
      {
        id: 'agent-catalog-pre-v1',
        compatibility: 'previous-binary',
        createdAtMs: 1_752_000_000_000,
        sizeBytes: 1024
      }
    ]),
    restore: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides
  }
  ;(window as unknown as { api: unknown }).api = {
    dataRecovery: api,
    ui: { writeClipboardText: mocks.writeClipboardText }
  }
  return api
}

describe('DataRecoveryMigrationNotice', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.writeClipboardText.mockResolvedValue(undefined)
  })

  afterEach(() => {
    cleanup()
  })

  it('renders nothing when the migration is healthy', async () => {
    installApi({
      migrationStatus: vi.fn().mockResolvedValue({ agentCatalogMigrationError: null })
    })
    render(<DataRecoveryMigrationNotice />)
    await vi.waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it('renders nothing on paired web where the dataRecovery surface is absent', async () => {
    ;(window as unknown as { api: unknown }).api = {}
    render(<DataRecoveryMigrationNotice />)
    await vi.waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it('shows the blocked state at load with error details and both actions', async () => {
    installApi()
    render(<DataRecoveryMigrationNotice />)
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByText('disk full')).toBeTruthy()
    expect(screen.getByText('Retry migration')).toBeTruthy()
    expect(screen.getByText('Open Data recovery')).toBeTruthy()
  })

  it('clears the notice when retry succeeds and keeps it when retry fails', async () => {
    const api = installApi({
      retryAgentCatalogMigration: vi
        .fn()
        .mockResolvedValueOnce({ ok: false, error: 'still failing' })
        .mockResolvedValueOnce({ ok: true })
    })
    api.migrationStatus
      .mockResolvedValueOnce({ agentCatalogMigrationError: 'disk full' })
      .mockResolvedValue({ agentCatalogMigrationError: 'still failing' })
    render(<DataRecoveryMigrationNotice />)
    const retry = await screen.findByText('Retry migration')

    fireEvent.click(retry)
    await vi.waitFor(() => expect(screen.getByText('still failing')).toBeTruthy())

    fireEvent.click(screen.getByText('Retry migration'))
    await vi.waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it('shows a non-retryable read-only notice when the profile schema is too new', async () => {
    installApi({
      migrationStatus: vi.fn().mockResolvedValue({
        agentCatalogMigrationError: null,
        agentCatalogSchemaTooNew: { persistedVersion: 2, supportedVersion: 1 }
      })
    })
    render(<DataRecoveryMigrationNotice />)
    expect(
      await screen.findByText('Custom agents are read-only in this version of Orca')
    ).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('saved by a newer version of Orca')
    expect(
      screen.getByText('Profile agent catalog v2; this version of Orca supports v1.')
    ).toBeTruthy()
    // Retry re-runs the pinned backup, which cannot clear a newer schema.
    expect(screen.queryByText('Retry migration')).toBeNull()
  })

  it('prefers the read-only notice over a retry offer when both states are reported', async () => {
    installApi({
      migrationStatus: vi.fn().mockResolvedValue({
        agentCatalogMigrationError: 'disk full',
        agentCatalogSchemaTooNew: { persistedVersion: 3, supportedVersion: 1 }
      })
    })
    render(<DataRecoveryMigrationNotice />)
    expect(
      await screen.findByText('Custom agents are read-only in this version of Orca')
    ).toBeTruthy()
    expect(screen.queryByText('Retry migration')).toBeNull()
  })

  it('ignores an older host that never sends the schema field', async () => {
    installApi({
      migrationStatus: vi.fn().mockResolvedValue({ agentCatalogMigrationError: 'disk full' })
    })
    render(<DataRecoveryMigrationNotice />)
    expect(await screen.findByText('Retry migration')).toBeTruthy()
    expect(screen.queryByText('Custom agents are read-only in this version of Orca')).toBeNull()
  })

  it('copies the error through the app clipboard IPC and confirms with a toast', async () => {
    installApi()
    render(<DataRecoveryMigrationNotice />)
    fireEvent.click(await screen.findByText('Copy details'))
    await vi.waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledTimes(1))
    expect(mocks.writeClipboardText).toHaveBeenCalledWith('disk full')
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('surfaces a failure toast when the clipboard write rejects', async () => {
    installApi()
    mocks.writeClipboardText.mockRejectedValue(new Error('clipboard unavailable'))
    render(<DataRecoveryMigrationNotice />)
    fireEvent.click(await screen.findByText('Copy details'))
    await vi.waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1))
    expect(mocks.toastSuccess).not.toHaveBeenCalled()
  })

  it('opens Data recovery listing the pinned point with restore', async () => {
    const api = installApi()
    render(<DataRecoveryMigrationNotice />)
    fireEvent.click(await screen.findByText('Open Data recovery'))
    expect(await screen.findByText('Before custom agents')).toBeTruthy()
    fireEvent.click(screen.getByText('Restore these settings…'))
    fireEvent.click(screen.getByText('Restore and quit'))
    await vi.waitFor(() =>
      expect(api.restore).toHaveBeenCalledWith({
        id: 'agent-catalog-pre-v1',
        mode: 'prepare-downgrade'
      })
    )
  })
})
