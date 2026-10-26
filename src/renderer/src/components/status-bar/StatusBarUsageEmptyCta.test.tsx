// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../../store'
import { TooltipProvider } from '../ui/tooltip'
import { StatusBarUsageEmptyCta } from './StatusBarUsageEmptyCta'

describe('StatusBarUsageEmptyCta', () => {
  const openSettingsTarget = vi.fn()
  const openSettingsPage = vi.fn()

  beforeEach(() => {
    openSettingsTarget.mockReset()
    openSettingsPage.mockReset()
    useAppStore.setState({ openSettingsTarget, openSettingsPage })
  })
  afterEach(() => cleanup())

  function renderCta(remoteOwner: Parameters<typeof StatusBarUsageEmptyCta>[0]['remoteOwner']) {
    render(
      <TooltipProvider>
        <StatusBarUsageEmptyCta remoteOwner={remoteOwner} />
      </TooltipProvider>
    )
  }

  it('teaches setup on this device when this device owns usage', () => {
    renderCta(null)
    fireEvent.click(screen.getByRole('button', { name: 'Configure usage tracking' }))
    // Why explicit: otherwise Settings opens on the "default host for new projects".
    expect(openSettingsTarget).toHaveBeenCalledWith({
      pane: 'accounts',
      repoId: null,
      hostScope: { kind: 'local' }
    })
    expect(openSettingsPage).toHaveBeenCalled()
  })

  it("names the remote host and opens that host's accounts", () => {
    renderCta({ environmentId: 'linux-box', label: 'Linux box' })
    expect(screen.queryByText('Configure usage tracking')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'No usage on Linux box' }))
    expect(openSettingsTarget).toHaveBeenCalledWith({
      pane: 'accounts',
      repoId: null,
      hostScope: { kind: 'environment', environmentId: 'linux-box' }
    })
  })
})
