import { defineFixture } from '../../../../component-fixtures/component-fixture'
import type { ConnectorLink } from '../../../../../../shared/connectors/connector-links-contract'
import { LinkedAccountsList, type LinkedAccountsTrip } from './LinkedAccountsList'

const LINKS: ConnectorLink[] = [
  {
    source: 'github',
    workspaceId: 'github.com',
    workspaceName: '',
    userId: '101',
    name: 'mara-lin',
    linkedAt: 1
  },
  {
    source: 'github',
    workspaceId: 'github.com',
    workspaceName: '',
    userId: '102',
    name: 'mara-test',
    linkedAt: 2
  },
  {
    source: 'linear',
    workspaceId: 'L1',
    workspaceName: 'Northwind',
    userId: 'P1',
    name: 'mara@northwind.dev',
    linkedAt: 1
  }
]

const SLACK_LINKS: ConnectorLink[] = [
  {
    source: 'slack',
    workspaceId: 'T1',
    workspaceName: 'Northwind',
    userId: 'U1',
    name: 'Mara Lin',
    linkedAt: 1
  },
  {
    source: 'slack',
    workspaceId: 'T2',
    workspaceName: 'Acme Partners',
    userId: 'U2',
    name: 'mara',
    linkedAt: 2
  }
]

const IDLE: LinkedAccountsTrip = { waiting: false, error: null, canLink: true }
const noop = (): void => {}

function list(links: ConnectorLink[] = LINKS, trips = { slack: IDLE, github: IDLE, linear: IDLE }) {
  return (
    <LinkedAccountsList links={links} trips={trips} onLink={noop} onCancel={noop} onUnlink={noop} />
  )
}

function buttonNamed(frame: HTMLElement, name: string, index = 0): HTMLButtonElement {
  const button = Array.from(frame.ownerDocument.querySelectorAll('button')).filter(
    (entry) => entry.textContent === name || entry.getAttribute('aria-label') === name
  )[index]
  if (!button) {
    throw new Error(`No ${name} button`)
  }
  return button
}

export const linked = defineFixture({ width: 720, render: () => list() })

/** Keyboard focus (and hover) on a not-linked row swaps Not linked for Link. */
export const notLinkedFocused = defineFixture({
  width: 720,
  render: () => list(),
  interact: (frame) => buttonNamed(frame, 'Link').focus()
})

export const unlinkConfirm = defineFixture({
  width: 720,
  render: () => list(),
  interact: (frame) => buttonNamed(frame, 'Unlink', 1).click()
})

export const linkMenu = defineFixture({
  width: 720,
  render: () => list(),
  interact: (frame) => {
    buttonNamed(frame, 'Link account').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
    )
  }
})

export const severalPerService = defineFixture({
  width: 720,
  render: () => list([...SLACK_LINKS, ...LINKS])
})

export const linking = defineFixture({
  width: 720,
  render: () =>
    list(
      LINKS.filter((link) => link.source !== 'linear'),
      {
        slack: IDLE,
        github: { waiting: true, error: null, canLink: true },
        linear: IDLE
      }
    )
})

export const nothingLinked = defineFixture({ width: 720, render: () => list([]) })
