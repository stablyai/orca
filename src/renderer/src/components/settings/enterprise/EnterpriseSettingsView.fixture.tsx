import { defineFixture } from '../../../component-fixtures/component-fixture'
import { SettingsSection } from '../section-layout/SettingsSection'
import { EnterpriseSettingsView } from './EnterpriseSettingsView'
import { fixtureAuditProps } from './enterprise-fixture-data'
import type { EnterpriseAuditLogProps } from './EnterpriseAuditLog'

const BARE_BODY = 'rounded-none border-0 bg-transparent p-0 shadow-none'

/** The pane as Settings draws it: page title and description over the bare body. */
function Page({ audit }: { audit: EnterpriseAuditLogProps }): React.JSX.Element {
  return (
    <div className="bg-background px-8 py-6">
      <SettingsSection
        id="cloud-enterprise"
        title="Enterprise"
        description="Single sign-on, sign-in policies and the audit log for your team."
        forceVisible
        bodyClassName={BARE_BODY}
      >
        <EnterpriseSettingsView audit={audit} />
      </SettingsSection>
    </div>
  )
}

/** An Enterprise team's owner: the merged log, filters and export. */
export const auditLog = defineFixture({
  width: 860,
  render: () => <Page audit={fixtureAuditProps()} />
})

/** A team whose plan does not include the audit log (the control plane answered plan-required). */
export const upsell = defineFixture({
  width: 860,
  render: () => <Page audit={fixtureAuditProps({ log: { status: 'upsell' }, actors: [] })} />
})

/** Entitled, nothing recorded yet. */
export const empty = defineFixture({
  width: 860,
  render: () => (
    <Page
      audit={fixtureAuditProps({
        log: {
          status: 'ok',
          events: [],
          hasMore: false,
          loadingMore: false,
          moreError: null,
          refreshing: false
        },
        actors: []
      })}
    />
  )
})

/** Filters that match nothing: say so and offer the way back. */
export const emptyFiltered = defineFixture({
  width: 860,
  render: () => (
    <Page
      audit={fixtureAuditProps({
        log: {
          status: 'ok',
          events: [],
          hasMore: false,
          loadingMore: false,
          moreError: null,
          refreshing: false
        },
        filters: { category: 'billing', actor: 'u_grace' }
      })}
    />
  )
})

export const loading = defineFixture({
  width: 860,
  render: () => <Page audit={fixtureAuditProps({ log: { status: 'loading' }, actors: [] })} />
})

export const loadFailed = defineFixture({
  width: 860,
  render: () => (
    <Page
      audit={fixtureAuditProps({
        log: {
          status: 'error',
          message: 'Couldn’t reach Orca Cloud. Check your connection and try again.'
        },
        actors: []
      })}
    />
  )
})

/** After an export that hit the 5,000-event cap. */
export const exportTruncated = defineFixture({
  width: 860,
  render: () => (
    <Page audit={fixtureAuditProps({ exportState: { status: 'done', truncated: true } })} />
  )
})
