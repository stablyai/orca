import { useEffect, useRef } from 'react'
import type { ComponentType, JSX, ReactNode } from 'react'
import { Files, GitBranch, ListChecks, MessageSquare, Search } from 'lucide-react'
import { useShortcutLabel } from '@/hooks/useShortcutLabel'
import { ReviewPRViewVisualStyles } from './review-animated-visual-pr-view-styles'
import { CheckTinyIcon, ChevDownIcon, CursorIcon } from './review-animated-visual-shared'

type SidebarTabId = 'explorer' | 'search' | 'source-control' | 'checks'

const SIDEBAR_TABS: readonly {
  id: SidebarTabId
  icon: ComponentType<{ className?: string; size?: number }>
  label: string
}[] = [
  { id: 'explorer', icon: Files, label: 'Explorer' },
  { id: 'search', icon: Search, label: 'Search' },
  { id: 'source-control', icon: GitBranch, label: 'Source Control' },
  { id: 'checks', icon: ListChecks, label: 'Checks' }
]

function SidebarTabs(props: { active: SidebarTabId; interactiveChecks?: boolean }): JSX.Element {
  const checksShortcutLabel = useShortcutLabel('sidebar.checks.toggle')
  const checksTooltip =
    checksShortcutLabel === 'Unassigned' ? 'Checks' : `Checks (${checksShortcutLabel})`

  return (
    <div className="ravpr-tabs">
      {SIDEBAR_TABS.map((tab) => {
        const Icon = tab.icon
        const isActive = tab.id === props.active
        const className = ['ravpr-tab', isActive ? 'is-active' : ''].filter(Boolean).join(' ')
        return (
          <span
            key={tab.id}
            className={className}
            aria-label={tab.label}
            data-checks-tab={props.interactiveChecks && tab.id === 'checks' ? '' : undefined}
            data-explorer-tab={props.interactiveChecks && tab.id === 'explorer' ? '' : undefined}
          >
            <Icon size={16} aria-hidden />
          </span>
        )
      })}
      {props.interactiveChecks ? (
        <span className="ravpr-tooltip" data-checks-tooltip>
          {checksTooltip}
        </span>
      ) : null}
    </div>
  )
}

function StatusCell(): JSX.Element {
  return (
    <span>
      <span className="ravpr-ring" />
      <span className="ravpr-check">
        <CheckTinyIcon />
      </span>
    </span>
  )
}

function ExplorerSkeletonRow(props: { active?: boolean; width: number }): JSX.Element {
  return (
    <div className={props.active ? 'ravpr-file is-active' : 'ravpr-file'}>
      <span className="ravpr-file-icon" />
      <span className="ravpr-file-name" style={{ width: props.width }} />
      <span className="ravpr-file-status" />
    </div>
  )
}

function CommentCard(props: { index: number; path: string; children: ReactNode }): JSX.Element {
  return (
    <div className="ravpr-comment-card" data-comment-card={props.index}>
      <div className="ravpr-comment-head">
        <span className="ravpr-avatar" />
        <span className="ravpr-author" />
        <span className="ravpr-comment-path">{props.path}</span>
      </div>
      <div className="ravpr-comment-body">{props.children}</div>
    </div>
  )
}

function moveCursor(
  root: HTMLElement,
  cursor: HTMLElement,
  anchor: HTMLElement,
  ox = 0,
  oy = 0
): void {
  const rootRect = root.getBoundingClientRect()
  const anchorRect = anchor.getBoundingClientRect()
  cursor.style.transform = `translate(${anchorRect.left - rootRect.left + ox}px, ${
    anchorRect.top - rootRect.top + oy
  }px)`
}

// Why: the Review PR visual follows the approved HTML mock beat-for-beat. The
// real app keeps Explorer / Checks in one right-sidebar surface, so the
// animation selects Checks before the PR status content appears.
export function ReviewPRViewAnimatedVisual(props: { reducedMotion: boolean }): JSX.Element {
  const { reducedMotion } = props
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const root = rootRef.current
    if (!root) {
      return
    }

    const sidebarPeek = root.querySelector<HTMLDivElement>('[data-checks-sidebar-peek]')
    const prCard = root.querySelector<HTMLDivElement>('[data-pr-view-card]')
    const cursor = root.querySelector<HTMLDivElement>('[data-cursor]')
    const explorerTab = root.querySelector<HTMLSpanElement>('[data-explorer-tab]')
    const checksTab = root.querySelector<HTMLSpanElement>('[data-checks-tab]')
    const checksTooltip = root.querySelector<HTMLSpanElement>('[data-checks-tooltip]')
    const checksBlock = root.querySelector<HTMLDivElement>('[data-checks-block]')
    const commentsBlock = root.querySelector<HTMLDivElement>('[data-comments-block]')
    const comments = Array.from(root.querySelectorAll<HTMLDivElement>('[data-comment-card]'))
    const commentsCount = root.querySelector<HTMLSpanElement>('[data-comments-count]')
    const checkSummary = root.querySelector<HTMLDivElement>('[data-check-summary]')
    const checkSummaryLabel = root.querySelector<HTMLSpanElement>('[data-check-summary-label]')
    const checkSummaryMeta = root.querySelector<HTMLSpanElement>('[data-check-summary-meta]')
    const verifyRow = root.querySelector<HTMLDivElement>('[data-check-row="verify"]')
    const verifyState = root.querySelector<HTMLSpanElement>('[data-check-verify-state]')
    const mergeBtn = root.querySelector<HTMLButtonElement>('[data-merge-btn]')
    if (
      !sidebarPeek ||
      !prCard ||
      !cursor ||
      !explorerTab ||
      !checksTab ||
      !checksTooltip ||
      !checksBlock ||
      !commentsBlock ||
      !commentsCount ||
      !checkSummary ||
      !checkSummaryLabel ||
      !checkSummaryMeta ||
      !verifyRow ||
      !verifyState ||
      !mergeBtn
    ) {
      return
    }

    const rootEl: HTMLDivElement = root
    const sidebarPeekEl: HTMLDivElement = sidebarPeek
    const prCardEl: HTMLDivElement = prCard
    const cursorEl: HTMLDivElement = cursor
    const explorerTabEl: HTMLSpanElement = explorerTab
    const checksTabEl: HTMLSpanElement = checksTab
    const checksTooltipEl: HTMLSpanElement = checksTooltip
    const checksBlockEl: HTMLDivElement = checksBlock
    const commentsBlockEl: HTMLDivElement = commentsBlock
    const commentsCountEl: HTMLSpanElement = commentsCount
    const checkSummaryEl: HTMLDivElement = checkSummary
    const checkSummaryLabelEl: HTMLSpanElement = checkSummaryLabel
    const checkSummaryMetaEl: HTMLSpanElement = checkSummaryMeta
    const verifyRowEl: HTMLDivElement = verifyRow
    const verifyStateEl: HTMLSpanElement = verifyState
    const mergeBtnEl: HTMLButtonElement = mergeBtn

    let cancelled = false
    const timers: number[] = []
    const wait = (ms: number): Promise<void> =>
      new Promise((resolve) => {
        const id = window.setTimeout(() => resolve(), ms)
        timers.push(id)
      })

    function resetState(): void {
      sidebarPeekEl.classList.add('is-visible')
      sidebarPeekEl.classList.remove('is-hiding')
      prCardEl.classList.remove('is-visible')
      explorerTabEl.classList.add('is-active')
      checksTabEl.classList.remove('is-active', 'is-hovered')
      checksTooltipEl.classList.remove('is-visible')
      cursorEl.classList.remove('is-visible', 'is-clicking')
      cursorEl.style.transition = 'none'
      cursorEl.style.transform = 'translate(-30px, 220px)'
      void cursorEl.offsetWidth
      cursorEl.style.transition = ''
      checksBlockEl.classList.remove('is-visible')
      commentsBlockEl.classList.remove('is-visible')
      comments.forEach((el) => el.classList.remove('is-visible'))
      commentsCountEl.textContent = '0'
      checkSummaryEl.classList.remove('is-done')
      checkSummaryLabelEl.textContent = '1 pending'
      checkSummaryMetaEl.textContent = 'verify'
      verifyRowEl.classList.remove('is-done')
      verifyStateEl.textContent = 'Running'
      mergeBtnEl.classList.remove('is-ready')
    }

    function showFinalState(): void {
      resetState()
      sidebarPeekEl.classList.add('is-hiding')
      prCardEl.classList.add('is-visible')
      checksBlockEl.classList.add('is-visible')
      commentsBlockEl.classList.add('is-visible')
      comments.forEach((el) => el.classList.add('is-visible'))
      commentsCountEl.textContent = String(comments.length)
      checkSummaryEl.classList.add('is-done')
      checkSummaryLabelEl.textContent = 'Checks passed'
      checkSummaryMetaEl.textContent = '3 checks'
      verifyRowEl.classList.add('is-done')
      verifyStateEl.textContent = 'Passed'
      mergeBtnEl.classList.add('is-ready')
      cursorEl.classList.remove('is-visible')
    }

    if (reducedMotion) {
      showFinalState()
      return
    }

    async function loop(): Promise<void> {
      while (!cancelled) {
        resetState()
        await wait(420)
        if (cancelled) {
          return
        }

        cursorEl.classList.add('is-visible')
        moveCursor(rootEl, cursorEl, checksTabEl, 5, 6)
        checksTabEl.classList.add('is-hovered')
        await wait(260)
        if (cancelled) {
          return
        }
        checksTooltipEl.classList.add('is-visible')
        await wait(1300)
        if (cancelled) {
          return
        }

        cursorEl.classList.add('is-clicking')
        await wait(220)
        if (cancelled) {
          return
        }
        cursorEl.classList.remove('is-clicking')
        checksTooltipEl.classList.remove('is-visible')
        checksTabEl.classList.remove('is-hovered')
        explorerTabEl.classList.remove('is-active')
        checksTabEl.classList.add('is-active')
        await wait(420)
        if (cancelled) {
          return
        }

        sidebarPeekEl.classList.add('is-hiding')
        prCardEl.classList.add('is-visible')
        cursorEl.classList.remove('is-visible')
        await wait(560)
        if (cancelled) {
          return
        }

        checksBlockEl.classList.add('is-visible')
        await wait(1050)
        if (cancelled) {
          return
        }

        verifyRowEl.classList.add('is-done')
        verifyStateEl.textContent = 'Passed'
        checkSummaryEl.classList.add('is-done')
        checkSummaryLabelEl.textContent = 'Checks passed'
        checkSummaryMetaEl.textContent = '3 checks'
        mergeBtnEl.classList.add('is-ready')

        await wait(560)
        if (cancelled) {
          return
        }
        commentsBlockEl.classList.add('is-visible')
        await wait(260)
        if (cancelled) {
          return
        }

        for (let i = 0; i < comments.length; i++) {
          comments[i]?.classList.add('is-visible')
          commentsCountEl.textContent = String(i + 1)
          await wait(520)
          if (cancelled) {
            return
          }
        }

        await wait(2900)
      }
    }

    void loop()
    return () => {
      cancelled = true
      timers.forEach((timer) => window.clearTimeout(timer))
    }
  }, [reducedMotion])

  return (
    <div ref={rootRef} className="ravpr-stage" data-page="pr-view">
      <div className="ravpr-stack">
        <div className="ravpr-sidebar is-visible" data-checks-sidebar-peek>
          <SidebarTabs active="explorer" interactiveChecks />
          <div className="ravpr-explorer">
            <div className="ravpr-heading">Explorer</div>
            <div className="ravpr-file-list">
              <ExplorerSkeletonRow active width={190} />
              <ExplorerSkeletonRow width={158} />
              <ExplorerSkeletonRow width={176} />
              <ExplorerSkeletonRow width={132} />
            </div>
          </div>
        </div>

        <div className="ravpr-card" data-pr-view-card>
          <SidebarTabs active="checks" />
          <div className="ravpr-body">
            <div className="ravpr-number-row">
              <span className="ravpr-number">#2351</span>
              <span className="ravpr-open">OPEN</span>
            </div>
            <div className="ravpr-title">Add local diagnostics error tracking</div>
            <button className="ravpr-merge" data-merge-btn type="button">
              <GitBranch className="size-3" />
              Squash and merge
              <ChevDownIcon />
            </button>

            <div className="ravpr-reveal" data-checks-block>
              <div className="ravpr-section-row" data-check-summary>
                <StatusCell />
                <span className="ravpr-label" data-check-summary-label>
                  1 pending
                </span>
                <span className="ravpr-meta" data-check-summary-meta>
                  verify
                </span>
              </div>
              <div className="ravpr-check-list">
                <div className="ravpr-check-row" data-check-row="verify">
                  <StatusCell />
                  <span>verify</span>
                  <span className="ravpr-check-state" data-check-verify-state>
                    Running
                  </span>
                </div>
                <div className="ravpr-check-row is-done">
                  <StatusCell />
                  <span>typecheck</span>
                  <span className="ravpr-check-state">Passed</span>
                </div>
                <div className="ravpr-check-row is-done">
                  <StatusCell />
                  <span>lint</span>
                  <span className="ravpr-check-state">Passed</span>
                </div>
              </div>
            </div>

            <div className="ravpr-reveal" data-comments-block>
              <div className="ravpr-section-row">
                <MessageSquare className="size-3.5" />
                <span className="ravpr-label">Comments</span>
                <span className="ravpr-meta">
                  <span data-comments-count>0</span> open
                </span>
              </div>
              <div className="ravpr-comment-list">
                <CommentCard index={0} path="src/main/diagnostics.ts">
                  Can we include the failing command in the diagnostic payload?
                </CommentCard>
                <CommentCard index={1} path="tests/diagnostics.test.ts">
                  Add a coverage case for <code>stderr</code> truncation before merge.
                </CommentCard>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div className="ravpr-cursor" data-cursor>
        <CursorIcon />
        <span className="ravpr-ripple" />
      </div>
      <ReviewPRViewVisualStyles />
    </div>
  )
}
