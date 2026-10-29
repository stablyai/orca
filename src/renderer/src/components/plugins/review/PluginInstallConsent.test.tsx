// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { PluginInstallConsent } from './PluginInstallConsent'

afterEach(cleanup)

function renderConsent(
  worker: boolean,
  capabilities: { kind: string; description: string }[] = []
): void {
  render(
    <PluginInstallConsent
      trust={{ worker, declarative: false, panel: !worker }}
      capabilities={capabilities}
      shortcuts={[]}
      installed={null}
      official={false}
      publisher="samples"
      changed={false}
      error={null}
    />
  )
}

describe('PluginInstallConsent', () => {
  it('says that updates to a full-access plugin can change what its code does', () => {
    renderConsent(true)
    expect(screen.getByText('Updates can change its code without asking')).toBeTruthy()
  })

  it('keeps the plain update line for plugins without full access', () => {
    renderConsent(false)
    expect(screen.getByText('Updates ask again only for new access')).toBeTruthy()
  })

  it('never lists terminal access a panel cannot use, but keeps it for a worker', () => {
    const asked = [
      { kind: 'notifications:show', description: 'notifications:show' },
      { kind: 'terminal:send', description: 'terminal:send' }
    ]
    renderConsent(false, asked)
    expect(screen.queryByText(/Run commands in your terminals/)).toBeNull()
    expect(screen.getByText(/Show desktop notifications/)).toBeTruthy()
    cleanup()
    renderConsent(true, asked)
    expect(screen.getByText(/Run commands in your terminals/)).toBeTruthy()
  })
})
