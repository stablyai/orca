import { useEffect } from 'react'
import { toast } from 'sonner'
import { Toaster } from '@/components/ui/sonner'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import type { LocalBaseRefRefreshResult } from '../../../../../../shared/worktree/base-refs/base-ref-drift-types'
import { showLocalBaseRefRefreshToast } from './local-base-ref-refresh-toast'

const LONG_PATH =
  '/Users/someone/projects/very-long-organization-name/orca-monorepo-checkouts/main-worktree'
const LONG_BRANCH = 'release/2026-11-hotfix-for-workspace-creation-local-base'

const toastStyle = (width: number): React.CSSProperties & Record<`--${string}`, string> => ({
  '--normal-bg': 'var(--notice-surface)',
  '--normal-text': 'var(--popover-foreground)',
  '--normal-border': 'var(--notice-border)',
  '--border-radius': 'var(--radius)',
  '--width': `${width}px`
})

const showToast = (result: LocalBaseRefRefreshResult): void =>
  showLocalBaseRefRefreshToast(
    result,
    { id: 'wt', repoId: 'repo', displayName: 'feature-login', branch: 'feature-login', path: '/w' },
    { updateSettings: async () => {} }
  )

const settle = (ms = 600): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// Why 340px default: a narrow real toast; 240px is the design's minimum card width.
function ToastFrame({
  result,
  width = 340,
  then
}: {
  result: LocalBaseRefRefreshResult | LocalBaseRefRefreshResult[]
  width?: number
  then?: () => void
}): React.JSX.Element {
  useEffect(() => {
    for (const each of Array.isArray(result) ? result : [result]) {
      showToast(each)
    }
    then?.()
  }, [result, then])
  return (
    <div style={{ height: 380, position: 'relative', transform: 'translateZ(0)' }}>
      <Toaster
        closeButton
        toastOptions={{ className: 'font-sans text-sm' }}
        style={toastStyle(width)}
      />
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
export const notFastForwardNarrow = defineFixture({
  width: 272,
  render: () => <ToastFrame result={{ ...dirty, status: 'skipped_not_fast_forward' }} width={240} />
})
export const notFastForwardNarrowOpen = defineFixture({
  width: 272,
  render: () => (
    <ToastFrame result={{ ...dirty, status: 'skipped_not_fast_forward' }} width={240} />
  ),
  interact: openDetails
})
export const longBranchNarrow = defineFixture({
  width: 272,
  render: () => <ToastFrame result={longBranch} width={240} />
})

const shallow: LocalBaseRefRefreshResult = {
  status: 'skipped_not_fast_forward',
  baseRef: 'origin/main',
  localBranch: 'main',
  shallowHistory: true
}
const notFastForwardResult: LocalBaseRefRefreshResult = {
  ...dirty,
  status: 'skipped_not_fast_forward'
}
// Why: a later create in the same repo can flip between the shallow and refresh variants.
export const shallowThenRefresh = defineFixture({
  width: 372,
  render: () => <ToastFrame result={[shallow, notFastForwardResult]} />,
  interact: () => settle()
})
export const refreshThenShallow = defineFixture({
  width: 372,
  render: () => <ToastFrame result={[notFastForwardResult, shallow]} />,
  interact: () => settle()
})
const closeThenShow =
  (next: LocalBaseRefRefreshResult) =>
  async (frame: HTMLElement): Promise<void> => {
    await settle(300)
    frame.ownerDocument.querySelector<HTMLButtonElement>('[data-close-button]')?.click()
    await settle()
    showToast(next)
    await settle()
  }
export const refreshClosedThenShallow = defineFixture({
  width: 372,
  render: () => <ToastFrame result={notFastForwardResult} />,
  interact: closeThenShow(shallow)
})
export const shallowClosedThenRefresh = defineFixture({
  width: 372,
  render: () => <ToastFrame result={shallow} />,
  interact: closeThenShow(notFastForwardResult)
})
export const refreshClosedThenRefresh = defineFixture({
  width: 372,
  render: () => <ToastFrame result={notFastForwardResult} />,
  interact: closeThenShow(notFastForwardResult)
})
const showNewerToast = (): void => {
  toast.success('Workspace created')
}
export const stackedBehind = defineFixture({
  width: 372,
  render: () => <ToastFrame result={notFastForwardResult} then={showNewerToast} />
})
export const stackedExpanded = defineFixture({
  width: 372,
  render: () => <ToastFrame result={notFastForwardResult} then={showNewerToast} />,
  interact: async (frame) => {
    await new Promise((resolve) => setTimeout(resolve, 300))
    frame.ownerDocument
      .querySelector('[data-sonner-toaster]')
      ?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    frame.ownerDocument
      .querySelector('[data-sonner-toast]')
      ?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 600))
  }
})
