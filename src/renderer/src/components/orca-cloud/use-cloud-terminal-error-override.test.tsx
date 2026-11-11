// @vitest-environment happy-dom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { seedCloudWorkspaceSnapshot } from '@/lib/orca-cloud/orca-cloud-workspace-store'
import type { HostedWorkspaceStatus } from '../../../../shared/hosted-sandbox/hosted-sandbox-wire'
import { RUNTIME_ENVIRONMENT_ASLEEP_MESSAGE } from '../../../../shared/remote-runtime/recipe-vm-wake'
import { TerminalErrorToast } from '../terminal-pane/errors/TerminalErrorToast'

vi.mock('@/components/sidebar/workspace-actions/sleep/use-worktree-sleep-state', () => ({
  useIsSleepingWorktree: () => false
}))

// A fixed clock: the gate reads state, not time.
const T0 = 1_800_000_000_000

const status = (state: HostedWorkspaceStatus['state']): HostedWorkspaceStatus => ({
  state,
  metrics: null,
  uptimeMs: null,
  usage: { totalMs: 0, centsPerHour: 100, costCents: 0 },
  archive: null,
  checkedAt: T0
})

function seed(state: HostedWorkspaceStatus['state']): void {
  seedCloudWorkspaceSnapshot({
    ids: new Set(['ws']),
    idsLoaded: true,
    status: { ws: { status: status(state), loading: false, error: null, fetchedAt: T0 } }
  })
}

const toast = (worktreeId: string, error: string) => (
  <TerminalErrorToast
    worktreeId={worktreeId}
    error={error}
    paneOnClient={false}
    onDismiss={() => {}}
  />
)

afterEach(() => {
  cleanup()
  seedCloudWorkspaceSnapshot({})
})

describe('terminal error toast on an Orca Cloud workspace that sleeps', () => {
  it('shows nothing while it wakes: the waking pill owns that state', () => {
    seed('waking')
    const { container } = render(toast('ws', RUNTIME_ENVIRONMENT_ASLEEP_MESSAGE))
    expect(container.textContent).toBe('')
  })

  it('asleep: no red toast either (the pane shows the calm asleep line), also for the old "VM" wording', () => {
    seed('sleeping')
    for (const error of [
      RUNTIME_ENVIRONMENT_ASLEEP_MESSAGE,
      "This workspace's VM is asleep. Open the workspace to wake it."
    ]) {
      const { container, unmount } = render(toast('ws', error))
      expect(container.querySelector('[data-terminal-error-toast]')).toBeNull()
      expect(container.textContent).not.toContain('file an issue')
      unmount()
    }
  })

  it('leaves other workspaces and other errors to the regular toast', () => {
    seed('sleeping')
    const other = render(toast('local-ws', RUNTIME_ENVIRONMENT_ASLEEP_MESSAGE))
    expect(other.container.querySelector('[data-terminal-error-toast]')).not.toBeNull()
    other.unmount()
    const unrelated = render(toast('ws', 'spawn failed: ENOENT'))
    expect(unrelated.container.querySelector('[data-terminal-error-toast]')).not.toBeNull()
  })

  // Glossary lint allowlists these two "VM" match patterns because they are never rendered. If
  // that ever changes, this fails before the banned word reaches a cloud user.
  it('never renders the legacy "VM" sleep errors it matches (glossary allowlist)', () => {
    seed('sleeping')
    for (const error of [
      "This workspace's VM is asleep",
      "This workspace's VM could not wake up"
    ]) {
      const { container, unmount } = render(toast('ws', error))
      expect(container.textContent).not.toMatch(/\bVM\b/)
      unmount()
    }
  })
})
