import { useEffect } from 'react'
import { Toaster } from '@/components/ui/sonner'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import type { LocalBaseRefRefreshResult } from '../../../../../../shared/worktree/base-refs/base-ref-drift-types'
import { showLocalBaseRefRefreshToast } from './local-base-ref-refresh-toast'

const LONG_PATH =
  '/Users/someone/projects/very-long-organization-name/orca-monorepo-checkouts/main-worktree'
const LONG_BRANCH = 'release/2026-11-hotfix-for-workspace-creation-local-base'

// Why 340px: the narrowest real toast width (sonner's --width clamps to the window).
const NARROWEST_TOAST_STYLE: React.CSSProperties & Record<`--${string}`, string> = {
  '--normal-bg': 'var(--notice-surface)',
  '--normal-text': 'var(--popover-foreground)',
  '--normal-border': 'var(--notice-border)',
  '--border-radius': 'var(--radius)',
  '--width': '340px'
}

function ToastFrame({ result }: { result: LocalBaseRefRefreshResult }): React.JSX.Element {
  useEffect(() => {
    showLocalBaseRefRefreshToast(
      result,
      {
        id: 'wt',
        repoId: 'repo',
        displayName: 'feature-login',
        branch: 'feature-login',
        path: '/w'
      },
      { updateSettings: async () => {} }
    )
  }, [result])
  return (
    <div style={{ height: 380, position: 'relative', transform: 'translateZ(0)' }}>
      <Toaster style={NARROWEST_TOAST_STYLE} />
    </div>
  )
}

// Hover first: sonner pins an expanded (hovered) toast to its measured height.
const openDetails = async (frame: HTMLElement): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 300))
  const doc = frame.ownerDocument
  doc
    .querySelector('[data-sonner-toast]')
    ?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  doc.querySelector<HTMLButtonElement>('[aria-expanded]')?.click()
  await new Promise((resolve) => setTimeout(resolve, 600))
}

const dirty: LocalBaseRefRefreshResult = {
  status: 'skipped_dirty_worktree',
  baseRef: 'origin/main',
  localBranch: 'main',
  ownerWorktreePath: LONG_PATH
}
const longBranch: LocalBaseRefRefreshResult = {
  status: 'skipped_not_fast_forward',
  baseRef: `origin/${LONG_BRANCH}`,
  localBranch: LONG_BRANCH
}

export const dirtyClosed = defineFixture({
  width: 372,
  render: () => <ToastFrame result={dirty} />
})
export const dirtyOpen = defineFixture({
  width: 372,
  render: () => <ToastFrame result={dirty} />,
  interact: openDetails
})
export const notFastForward = defineFixture({
  width: 372,
  render: () => <ToastFrame result={{ ...dirty, status: 'skipped_not_fast_forward' }} />
})
export const gitError = defineFixture({
  width: 372,
  render: () => <ToastFrame result={{ ...dirty, status: 'skipped_error' }} />
})
export const longBranchClosed = defineFixture({
  width: 372,
  render: () => <ToastFrame result={longBranch} />
})
export const longBranchOpen = defineFixture({
  width: 372,
  render: () => <ToastFrame result={longBranch} />,
  interact: openDetails
})
