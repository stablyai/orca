// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { WindowsFirewallNotice } from './WindowsFirewallNotice'

afterEach(cleanup)

function setMobileApi(overrides: Record<string, unknown> = {}): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      mobile: {
        getWindowsFirewallStatus: vi.fn().mockResolvedValue({ supported: false }),
        repairWindowsFirewall: vi.fn().mockResolvedValue({ ok: true }),
        openWindowsNetworkSettings: vi.fn().mockResolvedValue(true),
        ...overrides
      }
    }
  })
}

describe('WindowsFirewallNotice', () => {
  it('stays hidden until a pairing code exists and Windows reports a missing rule', async () => {
    const getWindowsFirewallStatus = vi.fn().mockResolvedValue({
      supported: true,
      port: 6768,
      ruleAllowed: false,
      blockingRuleDetected: false,
      privateFirewallEnabled: true,
      networkCategory: 'private',
      inspectionAvailable: true
    })
    setMobileApi({ getWindowsFirewallStatus })
    const { rerender } = render(
      <WindowsFirewallNotice pairingReady={false} address="192.168.0.108" />
    )
    expect(screen.queryByText(/allow phone connections through/i)).not.toBeInTheDocument()

    rerender(<WindowsFirewallNotice pairingReady address="192.168.0.108" />)
    expect(await screen.findByText(/allow phone connections through/i)).toBeInTheDocument()
    expect(screen.getByText(/TCP port 6768/i)).toBeInTheDocument()
  })

  it('repairs only after explicit user action and hides after success', async () => {
    const repairWindowsFirewall = vi.fn().mockResolvedValue({ ok: true })
    const getWindowsFirewallStatus = vi
      .fn()
      .mockResolvedValueOnce({
        supported: true,
        port: 6768,
        ruleAllowed: false,
        blockingRuleDetected: false,
        privateFirewallEnabled: true,
        networkCategory: 'private',
        inspectionAvailable: true
      })
      .mockResolvedValueOnce({
        supported: true,
        port: 6768,
        ruleAllowed: true,
        blockingRuleDetected: false,
        privateFirewallEnabled: true,
        networkCategory: 'private',
        inspectionAvailable: true
      })
    setMobileApi({
      getWindowsFirewallStatus,
      repairWindowsFirewall
    })
    const user = userEvent.setup()
    render(<WindowsFirewallNotice pairingReady address="192.168.0.108" />)

    await user.click(await screen.findByRole('button', { name: /allow phone connections/i }))
    expect(repairWindowsFirewall).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(getWindowsFirewallStatus).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(screen.queryByText(/allow phone connections through/i)).not.toBeInTheDocument()
    )
  })

  it('reports an overriding Block rule and stays actionable if repair cannot clear it', async () => {
    const blockedStatus = {
      supported: true,
      port: 6768,
      ruleAllowed: false,
      blockingRuleDetected: true,
      privateFirewallEnabled: true,
      networkCategory: 'private',
      inspectionAvailable: true
    }
    const getWindowsFirewallStatus = vi.fn().mockResolvedValue(blockedStatus)
    const repairWindowsFirewall = vi.fn().mockResolvedValue({ ok: true })
    setMobileApi({ getWindowsFirewallStatus, repairWindowsFirewall })
    const user = userEvent.setup()
    render(<WindowsFirewallNotice pairingReady address="192.168.0.108" />)

    expect(await screen.findByText(/Windows may be blocking Orca Mobile/i)).toBeInTheDocument()
    expect(screen.getByText(/Block rule can override/i)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /repair firewall access/i }))

    await waitFor(() => expect(getWindowsFirewallStatus).toHaveBeenCalledTimes(2))
    expect(screen.getByText(/Windows may be blocking Orca Mobile/i)).toBeInTheDocument()
  })

  it('ignores a stale inspection that resolves after a newer result', async () => {
    const blockedStatus = {
      supported: true,
      port: 6768,
      ruleAllowed: false,
      blockingRuleDetected: true,
      privateFirewallEnabled: true,
      networkCategory: 'private',
      inspectionAvailable: true
    }
    const clearedStatus = { ...blockedStatus, ruleAllowed: true, blockingRuleDetected: false }
    let resolveStale: (status: typeof blockedStatus) => void = () => {}
    const getWindowsFirewallStatus = vi
      .fn()
      .mockResolvedValueOnce(blockedStatus)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveStale = resolve
          })
      )
      .mockResolvedValueOnce(clearedStatus)
    setMobileApi({ getWindowsFirewallStatus })
    render(<WindowsFirewallNotice pairingReady address="192.168.0.108" />)
    expect(await screen.findByText(/Windows may be blocking Orca Mobile/i)).toBeInTheDocument()

    // Why: UAC elevation bounces window focus, so an older in-flight
    // inspection can resolve after a newer one and must not win.
    window.dispatchEvent(new Event('focus'))
    window.dispatchEvent(new Event('focus'))
    await waitFor(() => expect(getWindowsFirewallStatus).toHaveBeenCalledTimes(3))
    await waitFor(() =>
      expect(screen.queryByText(/Windows may be blocking Orca Mobile/i)).not.toBeInTheDocument()
    )

    await act(async () => {
      resolveStale(blockedStatus)
    })
    expect(screen.queryByText(/Windows may be blocking Orca Mobile/i)).not.toBeInTheDocument()
  })

  it('does not offer a firewall rule while the selected network is public', async () => {
    const openWindowsNetworkSettings = vi.fn().mockResolvedValue(true)
    setMobileApi({
      getWindowsFirewallStatus: vi.fn().mockResolvedValue({
        supported: true,
        port: 6768,
        ruleAllowed: true,
        blockingRuleDetected: false,
        privateFirewallEnabled: false,
        networkCategory: 'public',
        inspectionAvailable: true
      }),
      openWindowsNetworkSettings
    })
    const user = userEvent.setup()
    render(<WindowsFirewallNotice pairingReady address="192.168.0.108" />)

    expect(await screen.findByText(/marks this network as public/i)).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /allow phone connections/i })
    ).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /open network settings/i }))
    expect(openWindowsNetworkSettings).toHaveBeenCalledTimes(1)
  })

  it('does not offer a Private-profile rule on a managed domain network', async () => {
    const getWindowsFirewallStatus = vi.fn().mockResolvedValue({
      supported: true,
      port: 6768,
      ruleAllowed: false,
      blockingRuleDetected: false,
      privateFirewallEnabled: true,
      networkCategory: 'domain',
      inspectionAvailable: true
    })
    setMobileApi({
      getWindowsFirewallStatus
    })

    render(<WindowsFirewallNotice pairingReady address="10.0.0.4" />)

    await waitFor(() => expect(getWindowsFirewallStatus).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('button', { name: /allow phone connections/i })).toBeNull()
  })
})
