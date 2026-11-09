import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { ShareLink } from '../../../../../shared/hosted-sandbox/hosted-sandbox-share-wire'
import type { WorkspacePort } from '../../../../../shared/workspace-ports'
import { LocalPortRow } from '../local-port-row'
import { SharedLinksList, type SharedLinksListProps } from './shared-links-list'
import { SharePortDialog } from './share-port-dialog'

const NOW = Date.UTC(2026, 10, 9, 12, 0, 0)
const HOUR = 3_600_000
const BASE = 'https://share.example.com/s/'

function link(overrides: Partial<ShareLink> & Pick<ShareLink, 'id'>): ShareLink {
  return {
    sandboxId: 'sbx_ebdadca438c28066cdbd8ef3',
    port: 3000,
    audience: 'team',
    allowWake: false,
    url: `${BASE}${overrides.id}02e748f8a0c675cb5934/`,
    state: 'active',
    createdBy: 'user_1',
    createdAt: NOW - HOUR,
    expiresAt: NOW + 23 * HOUR,
    revokedAt: null,
    ...overrides
  }
}

const publicLink = link({
  id: '60bf1e1ad30e6b0c43ada070a92ff0c7',
  audience: 'public',
  allowWake: true,
  expiresAt: NOW + 50 * 60_000
})
const teamLink = link({ id: '92c7f4eb1d36d72d15a745241ab39cab' })
const weekLink = link({
  id: '76b9530b07d765a6d1c47b5535375537',
  port: 5173,
  expiresAt: NOW + 6 * 24 * HOUR
})
const expiredLink = link({
  id: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
  port: 8080,
  audience: 'public',
  expiresAt: NOW - 3 * 60_000
})
const revokedLink = link({
  id: 'ffeeddccbbaa99887766554433221100',
  audience: 'public',
  state: 'revoked',
  revokedAt: NOW - 2 * 60_000
})

const noop = () => {}
const copyOk = async () => true
const revokeOk = async () => true

function List(props: Partial<SharedLinksListProps>) {
  return (
    <div className="bg-background pb-3 text-foreground">
      <SharedLinksList
        status="ready"
        shares={[]}
        now={NOW}
        onShare={noop}
        onRetry={noop}
        onCopy={copyOk}
        onOpen={noop}
        onRevoke={revokeOk}
        {...props}
      />
    </div>
  )
}

export const empty = defineFixture({ width: 300, render: () => <List /> })

export const active = defineFixture({
  width: 300,
  render: () => <List shares={[publicLink, teamLink, weekLink]} />
})

export const expired = defineFixture({
  width: 300,
  render: () => <List shares={[teamLink, expiredLink]} />
})

export const revoked = defineFixture({
  width: 300,
  render: () => <List shares={[teamLink, revokedLink]} />
})

export const loadError = defineFixture({
  width: 300,
  render: () => <List status="error" shares={[teamLink]} errorText="Couldn’t load links." />
})

/** Clicking Turn off asks to confirm in place, with Cancel focused. */
export const revokeConfirm = defineFixture({
  width: 300,
  render: () => <List shares={[publicLink]} />,
  interact: (frame) => {
    frame.querySelector<HTMLButtonElement>('button[aria-label="Turn off link"]')?.click()
  }
})

/** Copy focused (keyboard), so the row's actions show with the check. */
export const copied = defineFixture({
  width: 300,
  render: () => <List shares={[publicLink]} />,
  interact: async (frame) => {
    frame.querySelector<HTMLButtonElement>('button[aria-label="Copy link"]')?.click()
    await new Promise((resolve) => setTimeout(resolve, 50))
    frame.querySelector<HTMLButtonElement>('button[aria-label="Copied"]')?.focus()
  }
})

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture data; only the fields LocalPortRow reads.
const devServer = {
  id: 'p3000',
  port: 3000,
  host: '0.0.0.0',
  protocol: 'http',
  pid: 4242,
  processName: 'vite',
  kind: 'workspace',
  owner: { displayName: 'checkout-v2', confidence: 'cwd' }
} as unknown as WorkspacePort

/** A port row above the shared links: icons, ports and text columns line up. */
export const besidePorts = defineFixture({
  width: 300,
  render: () => (
    <div className="bg-background pb-3 text-foreground">
      <div className="px-3 pt-2">
        <LocalPortRow port={devServer} onStop={noop} onShowDetails={noop} />
      </div>
      <SharedLinksList
        status="ready"
        shares={[publicLink, teamLink]}
        now={NOW}
        onShare={noop}
        onRetry={noop}
        onCopy={copyOk}
        onOpen={noop}
        onRevoke={revokeOk}
      />
    </div>
  )
})

function Dialog({
  port,
  created,
  detectedPorts
}: {
  port: number | null
  created?: ShareLink
  detectedPorts?: number[]
}) {
  return (
    <SharePortDialog
      open
      onOpenChange={noop}
      port={port}
      detectedPorts={detectedPorts}
      shares={[publicLink, teamLink, weekLink]}
      fixedNow={NOW}
      onCreate={async () => ({ ok: true, share: teamLink })}
      onCopy={copyOk}
      onOpen={noop}
      onRevoke={revokeOk}
      initialCreated={created ? { share: created, copied: true } : null}
    />
  )
}

export const dialogForm = defineFixture({ width: 560, render: () => <Dialog port={3000} /> })

export const dialogAnyPort = defineFixture({
  width: 560,
  render: () => <Dialog port={null} detectedPorts={[3000, 5173]} />
})

export const dialogCreated = defineFixture({
  width: 560,
  render: () => (
    <Dialog
      port={5173}
      created={link({ id: '0123456789abcdef0123456789abcdef', port: 5173, allowWake: true })}
    />
  )
})
