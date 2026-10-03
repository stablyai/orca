import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { PortForwardEntry } from '../../../../shared/ssh-types'
import { SshForwardedPortRow } from './ssh-forwarded-port-row'
import {
  resolvePortOpenModifierDestination,
  type PortOpenModifierDestination
} from '@/lib/workspace-port-open-routing'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, vars?: Record<string, unknown>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(vars?.[name] ?? ''))
}))

const entry: PortForwardEntry = {
  id: 'fwd-1',
  connectionId: 'ssh-1',
  localPort: 3001,
  remoteHost: '127.0.0.1',
  remotePort: 3000
}

function render(destination: PortOpenModifierDestination): string {
  return renderToStaticMarkup(
    <SshForwardedPortRow
      entry={entry}
      modifierDestination={destination}
      onEdit={vi.fn()}
      onOpenInBrowser={vi.fn()}
    />
  )
}

describe('SshForwardedPortRow open tooltip', () => {
  // Why this row and not a workspace port: an SSH forward listens on this machine's
  // loopback, so it is never a remote-host row and the modifier means whatever it means
  // for any local port. The hint must agree with the workspace-port rows next to it.
  it('offers no hint when a plain click already opens the system browser', () => {
    const destination = resolvePortOpenModifierDestination({ settings: { openLinksInApp: false } })
    expect(destination).toBeNull()
    expect(render(destination)).not.toContain('click for system browser')
  })

  it('names Orca for a user who inverted the modifier', () => {
    const destination = resolvePortOpenModifierDestination({
      settings: { openLinksInApp: false, openLinksInAppModifierInverts: true }
    })
    expect(render(destination)).toContain('click to open in Orca')
  })

  it('names the system browser once Link Routing sends a plain click into Orca', () => {
    const destination = resolvePortOpenModifierDestination({ settings: { openLinksInApp: true } })
    expect(render(destination)).toContain('click for system browser')
  })
})
