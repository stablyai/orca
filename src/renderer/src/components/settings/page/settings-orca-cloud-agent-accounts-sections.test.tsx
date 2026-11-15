// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  orcaCloudAgentAccountsLead,
  orcaCloudAgentAccountsParts
} from './settings-orca-cloud-agent-accounts-sections'
import type { SettingsRenderContext } from './settings-render-context'

function context(
  model: { showDesktopOnlySettings: boolean; orcaCloudApiAvailable: boolean },
  scrollToSection = vi.fn()
) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the parts and the lead read only these two model flags and actions.scrollToSection.
  return { model, actions: { scrollToSection } } as unknown as SettingsRenderContext
}

describe('Agent accounts: Orca Cloud parts', () => {
  it('adds Hosts after This computer; Orca Cloud sign-ins are their own Orca Cloud page', () => {
    const parts = orcaCloudAgentAccountsParts(
      context({ showDesktopOnlySettings: true, orcaCloudApiAvailable: true })
    )
    expect(parts.map((part) => part.id)).toEqual(['accounts-hosts'])
  })

  it('keeps one row that opens Cloud agent sign-ins', () => {
    const scrollToSection = vi.fn()
    const lead = orcaCloudAgentAccountsLead(
      context({ showDesktopOnlySettings: true, orcaCloudApiAvailable: true }, scrollToSection)
    )
    render(<>{lead}</>)
    fireEvent.click(screen.getByRole('button', { name: /Orca Cloud sign-ins live in/ }))
    expect(scrollToSection).toHaveBeenCalledWith('cloud-agent-sign-ins')
    for (const model of [
      { showDesktopOnlySettings: true, orcaCloudApiAvailable: false },
      { showDesktopOnlySettings: false, orcaCloudApiAvailable: true }
    ]) {
      expect(orcaCloudAgentAccountsLead(context(model))).toBeNull()
    }
  })

  it('adds nothing without an Orca Cloud control plane or outside the desktop', () => {
    expect(
      orcaCloudAgentAccountsParts(
        context({ showDesktopOnlySettings: true, orcaCloudApiAvailable: false })
      )
    ).toEqual([])
    expect(
      orcaCloudAgentAccountsParts(
        context({ showDesktopOnlySettings: false, orcaCloudApiAvailable: true })
      )
    ).toEqual([])
  })
})
