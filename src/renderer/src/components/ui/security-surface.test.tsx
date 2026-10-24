// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './dialog'
import { SecuritySurface } from './security-surface'

// Every dialog that asks the user to trust, approve, run or remove code. A new one belongs here.
const TRUST_DIALOGS = [
  'sidebar/OrcaYamlTrustDialog.tsx',
  'editor/IpynbViewer.tsx',
  'plugins/dialogs/PluginInstallDialog.tsx',
  'plugins/dialogs/PluginUpdateAllDialog.tsx',
  'plugins/dialogs/PluginMarketplaceSourceDialog.tsx',
  'plugins/dialogs/PluginRemoveDialog.tsx',
  'plugins/dialogs/PluginRollbackDialog.tsx'
]

// Trust decisions made outside a dialog: agent command approvals and certificate overrides.
const INLINE_TRUST_SURFACES = [
  'native-chat/NativeChatApprovalCard.tsx',
  'browser-pane/navigate/browser-load-failure-overlay.tsx',
  // Plugin install and review consent, inline on the plugin's page.
  'plugins/review/PluginInstallConsent.tsx'
]

afterEach(cleanup)

describe('security surfaces', () => {
  it('applies the host-owned token set', () => {
    render(
      <Dialog open>
        <DialogContent surface="security">
          <DialogTitle>Trust</DialogTitle>
          <DialogDescription>Review</DialogDescription>
        </DialogContent>
      </Dialog>
    )
    expect(document.querySelector('[role="dialog"]')?.classList).toContain('plugin-security-chrome')
  })

  it.each(TRUST_DIALOGS)('%s renders on the security surface', (file) => {
    const source = readFileSync(join(import.meta.dirname, '..', file), 'utf8')
    expect(source).toMatch(/<DialogContent\s[^>]*surface="security"/)
    expect(source).not.toContain('plugin-security-chrome')
  })

  it('applies the host-owned token set outside dialogs', () => {
    const { container } = render(
      <SecuritySurface>
        <div>Allow</div>
      </SecuritySurface>
    )
    expect(container.firstElementChild?.classList).toContain('plugin-security-chrome')
  })

  it.each(INLINE_TRUST_SURFACES)('%s renders inside a security surface', (file) => {
    const source = readFileSync(join(import.meta.dirname, '..', file), 'utf8')
    expect(source).toMatch(/<SecuritySurface[\s>]/)
  })
})
