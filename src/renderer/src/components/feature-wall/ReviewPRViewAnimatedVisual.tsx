import { useRef } from 'react'
import type { ComponentType, JSX, ReactNode } from 'react'
import { Files, GitBranch, ListChecks, MessageSquare, Search } from 'lucide-react'
import { useShortcutLabel } from '@/hooks/useShortcutLabel'
import { ReviewPRViewVisualStyles } from './review-animated-visual-pr-view-styles'
import { CheckTinyIcon, ChevDownIcon, CursorIcon } from './review-animated-visual-shared'
import { useReviewPrViewAnimation } from './review-pr-view-animation'
import { translate } from '@/i18n/i18n'

type SidebarTabId = 'explorer' | 'search' | 'source-control' | 'checks'

const SIDEBAR_TABS: readonly {
  id: SidebarTabId
  icon: ComponentType<{ className?: string; size?: number }>
  label: string
}[] = [
  {
    id: 'explorer',
    icon: Files,
    get label() {
      return translate(
        'auto.components.feature.wall.ReviewPRViewAnimatedVisual.6e3f5223c5',
        'Explorer'
      )
    }
  },
  {
    id: 'search',
    icon: Search,
    get label() {
      return translate(
        'auto.components.feature.wall.ReviewPRViewAnimatedVisual.8e715588e4',
        'Search'
      )
    }
  },
  {
    id: 'source-control',
    icon: GitBranch,
    get label() {
      return translate(
        'auto.components.feature.wall.ReviewPRViewAnimatedVisual.d7f80060ca',
        'Source Control'
      )
    }
  },
  {
    id: 'checks',
    icon: ListChecks,
    get label() {
      return translate(
        'auto.components.feature.wall.ReviewPRViewAnimatedVisual.ab2901bce6',
        'Checks'
      )
    }
  }
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

// Why: the Review PR visual follows the approved HTML mock beat-for-beat. The
// real app keeps Explorer / Checks in one right-sidebar surface, so the
// animation selects Checks before the PR status content appears.
export function ReviewPRViewAnimatedVisual(props: { reducedMotion: boolean }): JSX.Element {
  const { reducedMotion } = props
  const rootRef = useRef<HTMLDivElement | null>(null)

  useReviewPrViewAnimation(rootRef, reducedMotion)

  return (
    <div ref={rootRef} className="ravpr-stage" data-page="pr-view">
      <div className="ravpr-stack">
        <div className="ravpr-sidebar is-visible" data-checks-sidebar-peek>
          <SidebarTabs active="explorer" interactiveChecks />
          <div className="ravpr-explorer">
            <div className="ravpr-heading">
              {translate(
                'auto.components.feature.wall.ReviewPRViewAnimatedVisual.6e3f5223c5',
                'Explorer'
              )}
            </div>
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
              <span className="ravpr-open">
                {translate(
                  'auto.components.feature.wall.ReviewPRViewAnimatedVisual.dfe313e0c9',
                  'OPEN'
                )}
              </span>
            </div>
            <div className="ravpr-title">
              {translate(
                'auto.components.feature.wall.ReviewPRViewAnimatedVisual.0aab7ab84a',
                'Add local diagnostics error tracking'
              )}
            </div>
            <button className="ravpr-merge" data-merge-btn type="button">
              <GitBranch className="size-3" />
              {translate(
                'auto.components.feature.wall.ReviewPRViewAnimatedVisual.2f37142229',
                'Squash and merge'
              )}
              <ChevDownIcon />
            </button>

            <div className="ravpr-reveal" data-checks-block>
              <div className="ravpr-section-row" data-check-summary>
                <StatusCell />
                <span className="ravpr-label" data-check-summary-label>
                  {translate(
                    'auto.components.feature.wall.ReviewPRViewAnimatedVisual.9a097cae12',
                    '1 pending'
                  )}
                </span>
                <span className="ravpr-meta" data-check-summary-meta>
                  {translate(
                    'auto.components.feature.wall.ReviewPRViewAnimatedVisual.d340c052fb',
                    'verify'
                  )}
                </span>
              </div>
              <div className="ravpr-check-list">
                <div className="ravpr-check-row" data-check-row="verify">
                  <StatusCell />
                  <span>
                    {translate(
                      'auto.components.feature.wall.ReviewPRViewAnimatedVisual.d340c052fb',
                      'verify'
                    )}
                  </span>
                  <span className="ravpr-check-state" data-check-verify-state>
                    {translate(
                      'auto.components.feature.wall.ReviewPRViewAnimatedVisual.8ed213397c',
                      'Running'
                    )}
                  </span>
                </div>
                <div className="ravpr-check-row is-done">
                  <StatusCell />
                  <span>
                    {translate(
                      'auto.components.feature.wall.ReviewPRViewAnimatedVisual.2ef0b97954',
                      'typecheck'
                    )}
                  </span>
                  <span className="ravpr-check-state">
                    {translate(
                      'auto.components.feature.wall.ReviewPRViewAnimatedVisual.ca36f7b27c',
                      'Passed'
                    )}
                  </span>
                </div>
                <div className="ravpr-check-row is-done">
                  <StatusCell />
                  <span>
                    {translate(
                      'auto.components.feature.wall.ReviewPRViewAnimatedVisual.25f6838e43',
                      'lint'
                    )}
                  </span>
                  <span className="ravpr-check-state">
                    {translate(
                      'auto.components.feature.wall.ReviewPRViewAnimatedVisual.ca36f7b27c',
                      'Passed'
                    )}
                  </span>
                </div>
              </div>
            </div>

            <div className="ravpr-reveal" data-comments-block>
              <div className="ravpr-section-row">
                <MessageSquare className="size-3.5" />
                <span className="ravpr-label">
                  {translate(
                    'auto.components.feature.wall.ReviewPRViewAnimatedVisual.7a8b896e11',
                    'Comments'
                  )}
                </span>
                <span className="ravpr-meta">
                  <span data-comments-count>0</span>{' '}
                  {translate(
                    'auto.components.feature.wall.ReviewPRViewAnimatedVisual.fb1a856b6d',
                    'open'
                  )}
                </span>
              </div>
              <div className="ravpr-comment-list">
                <CommentCard index={0} path="src/main/diagnostics.ts">
                  {translate(
                    'auto.components.feature.wall.ReviewPRViewAnimatedVisual.71828fba75',
                    'Can we include the failing command in the diagnostic payload?'
                  )}
                </CommentCard>
                <CommentCard index={1} path="tests/diagnostics.test.ts">
                  {translate(
                    'auto.components.feature.wall.ReviewPRViewAnimatedVisual.6f4c2d7cb7',
                    'Add a coverage case for'
                  )}
                  <code>
                    {translate(
                      'auto.components.feature.wall.ReviewPRViewAnimatedVisual.c2062da7ec',
                      'stderr'
                    )}
                  </code>{' '}
                  {translate(
                    'auto.components.feature.wall.ReviewPRViewAnimatedVisual.7c2808ecff',
                    'truncation before merge.'
                  )}
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
