// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DataRecoveryPinExitNotice } from './DataRecoveryPinExitNotice'
import {
  PIN_EXIT_CUSTOM_AGENT_EXAMPLE_2_COMMAND,
  PIN_EXIT_CUSTOM_AGENT_EXAMPLE_2_NAME,
  PIN_EXIT_CUSTOM_AGENT_EXAMPLE_COMMAND,
  PIN_EXIT_CUSTOM_AGENT_EXAMPLE_NAME
} from './DataRecoveryPinExitCustomAgentExample'
import { dismissPinExitNotice } from './data-recovery-pin-exit-notice-dismissal'

const PIN = {
  id: 'agent-catalog-pre-v1' as const,
  compatibility: 'previous-binary' as const,
  createdAtMs: 1_752_000_000_000,
  sizeBytes: 1024
}

type ApiStub = {
  migrationStatus: ReturnType<typeof vi.fn>
  listPoints: ReturnType<typeof vi.fn>
  restore: ReturnType<typeof vi.fn>
  retryAgentCatalogMigration: ReturnType<typeof vi.fn>
}

function installApi(overrides: Partial<ApiStub> = {}): ApiStub {
  const api: ApiStub = {
    migrationStatus: vi.fn().mockResolvedValue({ agentCatalogMigrationError: null }),
    listPoints: vi.fn().mockResolvedValue([PIN]),
    restore: vi.fn().mockResolvedValue({ ok: true }),
    retryAgentCatalogMigration: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides
  }
  ;(window as unknown as { api: unknown }).api = { dataRecovery: api }
  return api
}

describe('DataRecoveryPinExitNotice', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
  })

  afterEach(() => {
    cleanup()
    localStorage.clear()
  })

  it('renders nothing when the dataRecovery surface is absent', async () => {
    ;(window as unknown as { api: unknown }).api = {}
    render(<DataRecoveryPinExitNotice />)
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('renders nothing when migration is blocked', async () => {
    installApi({
      migrationStatus: vi.fn().mockResolvedValue({ agentCatalogMigrationError: 'disk full' })
    })
    render(<DataRecoveryPinExitNotice />)
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('renders nothing when no recovery point exists', async () => {
    installApi({ listPoints: vi.fn().mockResolvedValue([]) })
    render(<DataRecoveryPinExitNotice />)
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('renders nothing when the only pin cannot be restored', async () => {
    installApi({
      listPoints: vi.fn().mockResolvedValue([{ ...PIN, restorable: false }])
    })
    render(<DataRecoveryPinExitNotice />)
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('shows exit guidance for a host that omits restorable', async () => {
    installApi({
      listPoints: vi.fn().mockResolvedValue([{ ...PIN, restorable: undefined }])
    })
    render(<DataRecoveryPinExitNotice />)
    expect(await screen.findByRole('dialog')).toBeTruthy()
  })

  it('shows exit guidance when a pin exists and migration is healthy', async () => {
    installApi()
    render(<DataRecoveryPinExitNotice />)
    expect(await screen.findByRole('dialog')).toBeTruthy()
    expect(screen.getByText('Custom agents are now available')).toBeTruthy()
    expect(
      screen.getByText(
        'Save a Codex, Claude, or other agent command under a name, then pick it from the agent list.'
      )
    ).toBeTruthy()
    expect(screen.getByText('Agent picker')).toBeTruthy()
    expect(screen.getByText('Codex')).toBeTruthy()
    expect(screen.getByText(PIN_EXIT_CUSTOM_AGENT_EXAMPLE_NAME)).toBeTruthy()
    expect(screen.getByText(PIN_EXIT_CUSTOM_AGENT_EXAMPLE_COMMAND)).toBeTruthy()
    expect(screen.getByText(PIN_EXIT_CUSTOM_AGENT_EXAMPLE_2_NAME)).toBeTruthy()
    expect(screen.getByText(PIN_EXIT_CUSTOM_AGENT_EXAMPLE_2_COMMAND)).toBeTruthy()
    expect(screen.queryByText('Claude')).toBeNull()
    expect(screen.getAllByText('Settings → Agents').length).toBeGreaterThanOrEqual(1)
    expect(
      screen.getByText('If you need to downgrade to a previous Orca version later')
    ).toBeTruthy()

    // Progressively disclosed when trigger is clicked
    fireEvent.click(screen.getByText('If you need to downgrade to a previous Orca version later'))
    expect(screen.getAllByText('Settings → Agents').length).toBe(2)
    expect(screen.getByText(/This version updated some Orca entity schema/)).toBeTruthy()
    expect(screen.getByText('Continue')).toBeTruthy()
    expect(screen.queryByText('Restore data backup…')).toBeNull()
    expect(screen.queryByText('Open Data recovery')).toBeNull()
    expect(screen.queryByText(/profile/i)).toBeNull()
  })

  it('dismisses for this pin and stays hidden after remount', async () => {
    installApi()
    const { unmount } = render(<DataRecoveryPinExitNotice />)
    fireEvent.click(await screen.findByText('Continue'))
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    unmount()
    render(<DataRecoveryPinExitNotice />)
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('reappears for a newer pin after a prior dismiss', async () => {
    dismissPinExitNotice(PIN.createdAtMs)
    installApi({
      listPoints: vi.fn().mockResolvedValue([{ ...PIN, createdAtMs: PIN.createdAtMs + 1 }])
    })
    render(<DataRecoveryPinExitNotice />)
    expect(await screen.findByRole('dialog')).toBeTruthy()
  })
})
