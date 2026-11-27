// @vitest-environment happy-dom

import { render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import type { WorktreeStatus } from '../../../../../../shared/worktree/row-display/worktree-status-rollup'
import { WorktreeCardStatusSlot } from './WorktreeCardStatusSlot'

const worktreeId = 'repo::/wt'

afterEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
})

function renderUnreadClassicSlot(status: WorktreeStatus): HTMLElement {
  return render(
    <TooltipProvider>
      <WorktreeCardStatusSlot
        worktreeId={worktreeId}
        status={status}
        showStatus
        showUnreadAction
        isUnread
        unreadTooltip="Mark read"
        onToggleUnread={() => {}}
        onPointerDown={() => {}}
      />
    </TooltipProvider>
  ).container
}

it('keeps the working spinner, with an unread dot, on an unread classic card', () => {
  const container = renderUnreadClassicSlot('working')
  expect(container.querySelector('button [data-agent-spinner]')).not.toBeNull()
  expect(container.querySelector('button [data-worktree-unread-alert]')).not.toBeNull()
})

it('keeps the question glyph, with an unread dot, on an unread classic card waiting on permission', () => {
  const container = renderUnreadClassicSlot('permission')
  expect(container.querySelector('button svg.text-agent-question')).not.toBeNull()
  expect(container.querySelector('button [data-worktree-unread-alert]')).not.toBeNull()
})

it('keeps the unread bell on a classic card whose ended turn is monitoring a background shell', () => {
  const container = renderUnreadClassicSlot('monitoring')
  expect(container.querySelector('button > svg.text-unread-bell')).not.toBeNull()
  expect(container.querySelector('button [data-worktree-unread-alert]')).toBeNull()
})

it('keeps the unread bell on a classic card whose VM is not running', () => {
  useAppStore.setState({
    ephemeralVmRuntimesByWorkspaceId: {
      [worktreeId]: {
        id: 'runtime-wt',
        workspaceId: worktreeId,
        status: 'suspended',
        runtimeEnvironmentId: 'env-wt',
        canSuspend: true
      }
    }
  })
  const container = renderUnreadClassicSlot('working')
  expect(container.querySelector('button > svg.text-unread-bell')).not.toBeNull()
  expect(container.querySelector('button [data-worktree-unread-alert]')).toBeNull()
})
