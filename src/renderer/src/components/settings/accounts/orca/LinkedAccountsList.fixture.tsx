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

const IDLE: LinkedAccountsTrip = { waiting: false, error: null, canLink: true }
const noop = (): void => {}

export const linked = defineFixture({
  width: 720,
  render: () => (
    <LinkedAccountsList
      links={LINKS}
      trips={{ slack: IDLE, github: IDLE, linear: IDLE }}
      onLink={noop}
      onCancel={noop}
      onUnlink={noop}
    />
  )
})

export const linking = defineFixture({
  width: 720,
  render: () => (
    <LinkedAccountsList
      links={LINKS.filter((link) => link.source !== 'linear')}
      trips={{ slack: IDLE, github: { waiting: true, error: null, canLink: true }, linear: IDLE }}
      onLink={noop}
      onCancel={noop}
      onUnlink={noop}
    />
  )
})

export const nothingLinked = defineFixture({
  width: 720,
  render: () => (
    <LinkedAccountsList
      links={[]}
      trips={{ slack: IDLE, github: IDLE, linear: IDLE }}
      onLink={noop}
      onCancel={noop}
      onUnlink={noop}
    />
  )
})
