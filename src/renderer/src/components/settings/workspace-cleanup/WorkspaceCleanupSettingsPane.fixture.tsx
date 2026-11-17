import { defineFixture } from '../../../component-fixtures/component-fixture'
import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'
import { getDefaultWorkspaceCleanupRules } from '../../../../../shared/workspace-cleanup/workspace-cleanup-policy'
import type { WorkspaceCleanupReport } from '../../../../../shared/workspace-cleanup/workspace-cleanup-run'
import { useAppStore } from '@/store'
import { WorkspaceCleanupSettingsPane } from './WorkspaceCleanupSettingsPane'

const settings = {
  ...getDefaultSettings('/Users/test'),
  workspaceCleanupPolicy: { ...getDefaultWorkspaceCleanupRules(), merged: { enabled: true } }
}

const startedAt = Date.parse('2026-11-16T09:00:00.000Z')

const report: WorkspaceCleanupReport = {
  running: false,
  nextRunAt: startedAt + 60 * 60 * 1000,
  runs: [
    {
      id: 'run-1',
      trigger: 'hourly',
      startedAt,
      finishedAt: startedAt + 4_000,
      counts: { removed: 1, archived: 0, kept: 0, failed: 0 },
      freedBytes: 412_000_000,
      chatHistory: { deleted: 38, failed: 0, freedBytes: 214_000_000 },
      rows: [
        {
          worktreeId: 'app::/Users/test/orca/workspaces/app/login-form',
          repoId: 'app',
          repoName: 'app',
          displayName: 'login-form',
          branch: 'login-form',
          path: '/Users/test/orca/workspaces/app/login-form',
          outcome: 'removed',
          reason: 'merged',
          prNumber: 412,
          sizeBytes: 412_000_000
        }
      ]
    }
  ]
}

function setup(): void {
  Object.assign(window.api, {
    runtime: {
      ...window.api.runtime,
      call: async ({ method }: { method: string }) => ({
        id: 'fixture',
        ok: true,
        result: method === 'workspaceCleanup.report' ? report : { evaluatedAt: 0, rows: [] }
      })
    }
  })
}

function Pane(): React.JSX.Element {
  const current = useAppStore((state) => state.settings)
  return (
    <WorkspaceCleanupSettingsPane
      hostScope={{ target: { kind: 'local' }, available: true }}
      settings={current}
      updateSettings={(updates) =>
        useAppStore.setState((state) => ({ settings: { ...state.settings!, ...updates } }))
      }
    />
  )
}

export const chatHistoryOff = defineFixture({
  width: 760,
  store: { settings },
  setup,
  render: () => <Pane />
})

export const chatHistoryConfirm = defineFixture({
  width: 760,
  store: { settings },
  setup,
  render: () => <Pane />,
  interact: async (frame) => {
    const toggle = frame.querySelector<HTMLElement>(
      '[role="switch"][aria-label="Delete chat history with the workspace"]'
    )
    toggle?.click()
  }
})
