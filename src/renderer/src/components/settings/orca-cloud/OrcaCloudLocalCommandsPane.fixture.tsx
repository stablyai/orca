import { defineFixture } from '../../../component-fixtures/component-fixture'
import { OrcaCloudLocalCommandsView } from './OrcaCloudLocalCommandsPane'

const NOW = 1_762_800_000_000

export const populated = defineFixture({
  width: 760,
  render: () => (
    <OrcaCloudLocalCommandsView
      now={NOW}
      pendingSandboxId={null}
      onToggle={() => {}}
      onRemoveRule={() => {}}
      onRetry={() => {}}
      state={{
        available: true,
        workspaces: [
          {
            sandboxId: 'sbx_000000000000000000000001',
            label: 'ios-login-fix',
            enabled: true,
            sharedAllowed: false,
            shared: false,
            isOwner: true,
            connected: true
          },
          {
            sandboxId: 'sbx_000000000000000000000002',
            label: 'payments-refactor',
            enabled: false,
            sharedAllowed: false,
            shared: true,
            isOwner: true,
            connected: false
          },
          {
            sandboxId: 'sbx_000000000000000000000003',
            label: 'docs-cleanup',
            enabled: false,
            sharedAllowed: false,
            shared: true,
            isOwner: false,
            connected: false
          }
        ],
        rules: [
          {
            id: 'rule-1',
            sandboxId: 'sbx_000000000000000000000001',
            workspaceLabel: 'ios-login-fix',
            command: 'xcrun simctl list devices booted',
            cwd: '/Users/neil',
            createdAt: NOW - 3_600_000
          }
        ]
      }}
      audit={[
        {
          at: NOW - 60_000,
          requestId: 'lc_a',
          sandboxId: 'sbx_000000000000000000000001',
          workspaceLabel: 'ios-login-fix',
          command: 'xcrun simctl list devices booted',
          cwd: '/Users/neil',
          agent: 'Claude Code',
          outcome: 'auto-allowed',
          exitCode: 0,
          durationMs: 412
        },
        {
          at: NOW - 600_000,
          requestId: 'lc_b',
          sandboxId: 'sbx_000000000000000000000001',
          workspaceLabel: 'ios-login-fix',
          command: 'security find-identity -p codesigning -v',
          cwd: '/Users/neil',
          agent: 'Claude Code',
          outcome: 'denied'
        },
        {
          at: NOW - 3_600_000,
          requestId: 'lc_c',
          sandboxId: 'sbx_000000000000000000000001',
          workspaceLabel: 'ios-login-fix',
          command: 'xcodebuild -scheme Acme test',
          cwd: '/Users/neil/projects/acme-ios',
          agent: 'Claude Code',
          outcome: 'allowed-once',
          exitCode: 65,
          durationMs: 93_000
        }
      ]}
    />
  )
})

export const empty = defineFixture({
  width: 760,
  render: () => (
    <OrcaCloudLocalCommandsView
      now={NOW}
      pendingSandboxId={null}
      onToggle={() => {}}
      onRemoveRule={() => {}}
      onRetry={() => {}}
      state={{ available: true, workspaces: [], rules: [] }}
      audit={[]}
    />
  )
})
