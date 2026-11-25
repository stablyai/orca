import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { useAppStore } from '@/store'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { FIXTURE_REPO, makeWorktree } from '../../worktree-card-slot-fixture-seeds'
import { Toaster } from '../../../ui/sonner'
import WorktreeCard from './WorktreeCard'
import { issueCacheKey } from '@/store/github/cache/cache-identity'

// Invented data. The issue URL carries a query so the shot proves the toast leaves it out.
const ISSUE_URL = 'https://example.com/org/repo/issues/7?token=fixture-secret'
const workspace: Worktree = {
  ...makeWorktree({ id: 'issue-open-failure', name: 'fix-login-flow', agents: [] }, Date.now()),
  linkedIssue: 7
}

async function waitFor<T>(read: () => T | null, label: string): Promise<T> {
  const deadline = performance.now() + 6000
  for (let found = read(); ; found = read()) {
    if (found) {
      return found
    }
    if (performance.now() > deadline) {
      throw new Error(`Timed out waiting for ${label}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/** The card's issue menu > Open in Orca browser fails; the toast names why, never the link. */
export const openInOrcaBrowserRefused = defineFixture({
  width: 400,
  setup: () =>
    useAppStore.setState((state) => ({
      repos: [FIXTURE_REPO],
      worktreesByRepo: { [FIXTURE_REPO.id]: [workspace] },
      worktreeCardProperties: ['status', 'branch', 'issue'],
      issueCache: {
        [issueCacheKey(FIXTURE_REPO.path, FIXTURE_REPO.id, 7, state.settings, null, null, true)]: {
          data: { number: 7, title: 'Login flow loops', state: 'open', url: ISSUE_URL, labels: [] },
          fetchedAt: Date.now()
        }
      },
      settings: state.settings
        ? {
            ...state.settings,
            experimentalNewWorktreeCardStyle: true,
            worktreeCardDetailsRow: true
          }
        : null,
      // If the open reaches a desktop tab, refuse it with a message naming the URL.
      createBrowserTab: () => {
        throw new Error(`tab refused for ${ISSUE_URL}`)
      }
    })),
  render: () => (
    <>
      <WorktreeCard
        worktree={workspace}
        repo={FIXTURE_REPO}
        isActive={false}
        hideRepoBadge
        nativeDragEnabled={false}
      />
      <div className="h-[120px]" />
      <Toaster closeButton toastOptions={{ className: 'font-sans text-sm' }} />
    </>
  ),
  interact: async (frame) => {
    const doc = frame.ownerDocument
    // The issue menu lives in the card's details hover, which opens when a pointer rests on it.
    for (const hoverTrigger of frame.querySelectorAll<HTMLElement>('[data-state="closed"]')) {
      for (const clientX of [20, 24]) {
        hoverTrigger.dispatchEvent(
          new PointerEvent('pointermove', {
            bubbles: true,
            pointerType: 'mouse',
            buttons: 0,
            clientX,
            clientY: 20
          })
        )
      }
    }
    const trigger = await waitFor(
      () => doc.querySelector<HTMLElement>('[aria-label="More issue actions"]'),
      'the issue menu'
    )
    trigger.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })
    )
    const item = await waitFor(
      () =>
        [...doc.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((entry) =>
          entry.textContent?.includes('Open in Orca browser')
        ) ?? null,
      'Open in Orca browser'
    )
    item.click()
    const toast = await waitFor(
      () => doc.querySelector<HTMLElement>('[data-sonner-toast][data-mounted="true"]'),
      'the failure toast'
    )
    const description = toast.querySelector('[data-description]')?.textContent ?? ''
    // Rollback-sensitive: the pre-fix handler showed the title alone.
    if (!description.trim()) {
      throw new Error('The toast did not name the cause')
    }
    if (
      toast.textContent?.includes('example.com') ||
      toast.textContent?.includes('fixture-secret')
    ) {
      throw new Error('The toast repeated the link')
    }
    // The toaster is fixed to the viewport corner; pin it in the frame for the shot.
    const toaster = doc.querySelector<HTMLElement>('[data-sonner-toaster]')
    if (toaster) {
      Object.assign(toaster.style, {
        position: 'absolute',
        top: `${frame.getBoundingClientRect().bottom - 8}px`,
        left: '8px',
        right: 'auto',
        bottom: 'auto'
      })
    }
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
})
