// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../../shared/execution-host'
import { NativeChatComposerBranchPicker } from './NativeChatComposerBranchPicker'

vi.mock('@/i18n/use-translate', () => ({
  useTranslate:
    () =>
    (_key: string, fallback: string, values?: Record<string, unknown>): string => {
      if (!values) {
        return fallback
      }
      return fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) =>
        String(values[name] ?? '')
      )
    }
}))

vi.mock('@/components/right-sidebar/source-control/sync/worktree-git-owner-target', () => ({
  useWorktreeGitOwnerTarget: () => ({ kind: 'local' })
}))

vi.mock('@/components/right-sidebar/source-control/branches/WorkspaceBranchPicker', () => ({
  WorkspaceBranchPicker: ({ trigger }: { trigger?: React.ReactNode }) => trigger ?? null
}))

vi.mock(
  '@/components/right-sidebar/source-control/branches/workspace-branch-switch-status',
  () => ({
    recordWorktreeBranchSwitchLanded: () => undefined
  })
)

describe('NativeChatComposerBranchPicker', () => {
  it('sizes the branch button to its label instead of the leftover row', () => {
    render(
      <NativeChatComposerBranchPicker
        worktreeId="wt"
        worktreePath="/repo"
        hostId={LOCAL_EXECUTION_HOST_ID}
        repoId="repo"
        branch="master"
        turnActive={false}
        textClassName="min-w-0"
        onCopyBranch={() => undefined}
        fallback={null}
      />
    )
    const button = screen.getByRole('button', { name: 'Switch branch: master' })
    const classes = button.className.split(/\s+/)
    expect(classes).not.toContain('flex-1')
    expect(classes).toContain('w-fit')
  })
})
