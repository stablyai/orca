// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { I18nProvider } from '@/i18n/I18nProvider'
import { TooltipProvider } from '../../ui/tooltip'
import type { WorkspaceCleanupPreviewRow } from '../../../../../shared/workspace-cleanup/workspace-cleanup-run'
import { cleanupChangeRowKey } from './workspace-cleanup-change-preview'
import { WorkspaceCleanupKeepSelection } from './workspace-cleanup-keep-selection'
import { WorkspaceCleanupRuleChangeDialog } from './workspace-cleanup-rule-change-dialog'

afterEach(cleanup)

function row(name: string): WorkspaceCleanupPreviewRow {
  return {
    worktreeId: `example::/synthetic/${name}`,
    instanceId: `instance-${name}`,
    repoId: 'example',
    repoName: 'Example project',
    displayName: name,
    branch: name,
    path: `/synthetic/${name}`,
    executionHostId: 'local',
    sizeBytes: 1048576,
    evaluation: { action: 'delete', reason: 'merged' }
  }
}

/** One New row and one row the current rules already delete. */
function renderDialog(): void {
  const added = row('added')
  const existing = row('existing')
  const selection = new WorkspaceCleanupKeepSelection([added, existing])
  render(
    <TooltipProvider>
      <I18nProvider>
        <WorkspaceCleanupRuleChangeDialog
          request={{
            kind: 'enable',
            setting: 'merged',
            projectName: 'Example project',
            rows: [added, existing],
            newKeys: new Set([cleanupChangeRowKey(added)]),
            currentKeys: new Set([cleanupChangeRowKey(existing)]),
            selection,
            status: null
          }}
          onCancel={() => {}}
          onConfirm={async () => {}}
          onToggleKeep={(target) => selection.toggle(target)}
        />
      </I18nProvider>
    </TooltipProvider>
  )
}

it('notes already-set rows only while one of them will still be deleted', () => {
  renderDialog()
  const note = () => screen.queryByText('Rows without New are already set to be deleted.')
  const keep = (name: string) =>
    act(() => fireEvent.click(screen.getByRole('checkbox', { name: `Keep ${name}` })))
  expect(note()).toBeTruthy()
  keep('added')
  expect(note()).toBeTruthy()
  keep('existing')
  expect(screen.getByText(/0 will be deleted/)).toBeTruthy()
  expect(note()).toBeNull()
  keep('added')
  expect(note()).toBeNull()
  expect(screen.queryByText('Kept workspaces get pinned.')).toBeNull()
})

it('shows no focusable list when nothing matches', () => {
  render(
    <TooltipProvider>
      <I18nProvider>
        <WorkspaceCleanupRuleChangeDialog
          request={{
            kind: 'disable-ignored-files',
            setting: 'keepIgnoredFiles',
            projectName: 'Example project',
            rows: [],
            newKeys: new Set(),
            currentKeys: new Set(),
            selection: new WorkspaceCleanupKeepSelection([]),
            status: null
          }}
          onCancel={() => {}}
          onConfirm={async () => {}}
          onToggleKeep={() => {}}
        />
      </I18nProvider>
    </TooltipProvider>
  )
  expect(screen.getByRole('dialog')).toBeTruthy()
  // An empty list box would still take a Tab stop and be announced as an empty list.
  expect(screen.queryByRole('list')).toBeNull()
})
