import { defineFixture } from '../../component-fixtures/component-fixture'
import { ClaudeStatsCacheSection, type ClaudeStatsCacheRow } from './ClaudeStatsCacheSection'
import { UsageTrackingPaneShell } from './UsageTrackingPaneShell'

function InPaneHeader({ homes }: { homes: ClaudeStatsCacheRow[] }): React.JSX.Element {
  return (
    <UsageTrackingPaneShell
      title="Claude Usage Tracking"
      enableLabel="Enable"
      onEnabledChange={() => {}}
      enabled
      status="Updated 11/5/2026, 12:20:07 AM"
      isRefreshing={false}
      hasData={false}
      optionsLabel="Options"
      filtersLabel="Filters"
      refreshAriaLabel="Refresh"
      refreshLabel="Refresh"
      filterSections={[]}
      selectionSummary="Orca worktrees only • Last 30 days"
      emptyMessage="No local Claude usage found yet for this scope."
      onRefresh={() => {}}
      titleAccessory={<ClaudeStatsCacheSection homes={homes} />}
    >
      {null}
    </UsageTrackingPaneShell>
  )
}

const okHome: ClaudeStatsCacheRow = {
  configHome: '/home/dev/.claude',
  label: '~/.claude',
  status: 'ok',
  totalTokens: 58_621_296_970,
  lastComputedDate: '2026-11-03',
  hostName: null,
  key: 'local:default'
}

export const singleHome = defineFixture({
  width: 1100,
  render: () => <InPaneHeader homes={[okHome]} />
})

export const multipleHomes = defineFixture({
  width: 1100,
  render: () => (
    <InPaneHeader
      homes={[
        okHome,
        {
          ...okHome,
          configHome: '/home/dev/claude-profiles/a1/home',
          label: 'work@example.com',
          key: 'local:a1',
          totalTokens: 92_310_455,
          lastComputedDate: '2026-10-28'
        },
        {
          configHome: '/home/dev/claude-profiles/b2/home',
          label: 'side@example.com',
          status: 'unavailable',
          reason: 'unsupported-version',
          hostName: null,
          key: 'local:b2'
        },
        {
          ...okHome,
          configHome: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\.claude',
          label: 'Ubuntu:/home/dev/.claude',
          key: 'local:wsl',
          totalTokens: 4_120_884
        },
        {
          ...okHome,
          hostName: 'build-box',
          key: 'env-ssh:default',
          totalTokens: 1_204_377_019
        }
      ]}
    />
  )
})
