import { cn } from '../../../lib/utils'
import { translate } from '@/i18n/i18n'

type Indicator = 'spinner' | 'green' | 'muted' | 'red'

type WorktreeRowProps = {
  indicator: Indicator
  name: string
  pr?: string
  repoColor: string
  repo: string
  branch: string
  preview?: string
  tcount?: number
  tapping?: boolean
}

export function WorktreeListSlide({ tapping }: { tapping: boolean }): React.JSX.Element {
  return (
    <div className="mp-device-screen">
      <div className="mp-wl-chrome">
        <div className="mp-wl-statusrow">
          <button
            type="button"
            className="mp-wl-back"
            aria-label={translate(
              'auto.components.mobile.slides.WorktreeListSlide.cefd048225',
              'Back'
            )}
          >
            <ChevronLeftIcon />
          </button>
          <div className="mp-wl-host">
            <span className="mp-status-dot is-green" />
            <span className="mp-wl-host-name">
              {translate(
                'auto.components.mobile.slides.WorktreeListSlide.b4271864bd',
                'MacBook Pro'
              )}
            </span>
          </div>
        </div>
        <div className="mp-wl-toolbar">
          <button type="button" className="mp-wl-chip">
            <FilterIcon />
            {translate('auto.components.mobile.slides.WorktreeListSlide.0e3e809a4b', 'Filter')}
          </button>
          <button type="button" className="mp-wl-button">
            <SortIcon />
            {translate('auto.components.mobile.slides.WorktreeListSlide.17f9e0d226', 'Recent')}
          </button>
          <button type="button" className="mp-wl-button">
            <GroupIcon />
            {translate('auto.components.mobile.slides.WorktreeListSlide.22971156df', 'Repo')}
          </button>
          <span className="mp-wl-spacer" />
          <span className="mp-wl-icon">
            <UserCircleIcon />
          </span>
          <span className="mp-wl-icon">
            <PlusIcon />
          </span>
          <span className="mp-wl-icon">
            <SearchIcon />
          </span>
        </div>
      </div>

      <div className="mp-wl-section">
        <CaretIcon />
        <PinIcon />
        <span style={{ marginLeft: 4 }}>
          {translate('auto.components.mobile.slides.WorktreeListSlide.79a24ff530', 'Pinned')}
        </span>
        <span style={{ marginLeft: 4, color: 'var(--m-text-muted)' }}>3</span>
      </div>

      <div className="mp-wl-list">
        <WorktreeRow
          indicator="spinner"
          name="feat/mobile-page"
          pr="#2491"
          repoColor="#3b82f6"
          repo="orca"
          branch="feat/mobile-page"
          preview="claude · refactoring v3 mock to use real screens…"
          tcount={2}
          tapping={tapping}
        />
        <div className="mp-wl-sep" />
        <WorktreeRow
          indicator="green"
          name="runtime/web-pairing"
          pr="#2487"
          repoColor="#22c55e"
          repo="orca"
          branch="feat/web-pairing"
          preview="$ pnpm test --filter web-runtime"
          tcount={1}
        />
        <div className="mp-wl-sep" />
        <WorktreeRow
          indicator="red"
          name="infra/notifier"
          repoColor="#f97316"
          repo="orca"
          branch="main"
          preview="awaiting permission · sudo apt install"
          tcount={1}
        />
      </div>

      <div className="mp-wl-section">
        <CaretIcon />
        <span>
          {translate('auto.components.mobile.slides.WorktreeListSlide.357a519567', 'Active')}
        </span>
        <span style={{ marginLeft: 4, color: 'var(--m-text-muted)' }}>37</span>
      </div>
      <div className="mp-wl-list">
        <WorktreeRow
          indicator="green"
          name="docs/styleguide-update"
          repoColor="#8b5cf6"
          repo="orca"
          branch="feat/styleguide"
          preview="$ pnpm lint"
          tcount={1}
        />
        <div className="mp-wl-sep" />
        <WorktreeRow
          indicator="muted"
          name="feat/runtime-perf"
          repoColor="#3b82f6"
          repo="orca"
          branch="feat/runtime-perf"
        />
        <div className="mp-wl-sep" />
        <WorktreeRow
          indicator="spinner"
          name="fix/notifier-cooldown"
          pr="#2483"
          repoColor="#f97316"
          repo="orca"
          branch="feat/notifier-cooldown"
          preview="claude · investigating macOS notification queue…"
          tcount={1}
        />
        <div className="mp-wl-sep" />
        <WorktreeRow
          indicator="muted"
          name="chore/deps-bump"
          repoColor="#22c55e"
          repo="orca"
          branch="feat/deps-bump"
        />
        <div className="mp-wl-sep" />
        <WorktreeRow
          indicator="green"
          name="experiment/ssh-multiplex"
          repoColor="#3b82f6"
          repo="orca"
          branch="feat/ssh-mux"
          preview="$ ssh -O check orca-relay"
          tcount={2}
        />
        <div className="mp-wl-sep" />
        <WorktreeRow
          indicator="muted"
          name="refactor/host-store"
          repoColor="#8b5cf6"
          repo="orca"
          branch="feat/host-store"
        />
      </div>
    </div>
  )
}

function WorktreeRow({
  indicator,
  name,
  pr,
  repoColor,
  repo,
  branch,
  preview,
  tcount,
  tapping
}: WorktreeRowProps): React.JSX.Element {
  return (
    <div className={cn('mp-wl-row', tapping && 'is-tapping')}>
      <div className="mp-wl-indicator">
        {indicator === 'spinner' ? (
          <div className="mp-wl-spinner" />
        ) : (
          <div className={cn('mp-wl-dot', `is-${indicator}`)} />
        )}
      </div>
      <div className="mp-wl-main">
        <div className="mp-wl-name-row">
          <div className="mp-wl-name">{name}</div>
          {pr ? (
            <div className="mp-wl-pr">
              <PrIcon />
              {pr}
            </div>
          ) : null}
        </div>
        <div className="mp-wl-meta-row">
          <span className="mp-repo-dot" style={{ background: repoColor }} />
          <span>{repo}</span>
          <span className="mp-wl-branch">{branch}</span>
        </div>
        {preview ? <div className="mp-wl-preview">{preview}</div> : null}
      </div>
      {tcount !== undefined ? <div className="mp-wl-tcount">{tcount}</div> : null}
    </div>
  )
}

function ChevronLeftIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <path d="m15 18-6-6 6-6" />
    </svg>
  )
}

function FilterIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
    </svg>
  )
}

function SortIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <line x1="21" y1="4" x2="14" y2="4" />
      <line x1="10" y1="4" x2="3" y2="4" />
      <line x1="21" y1="12" x2="12" y2="12" />
      <line x1="8" y1="12" x2="3" y2="12" />
      <line x1="21" y1="20" x2="16" y2="20" />
      <line x1="12" y1="20" x2="3" y2="20" />
      <line x1="14" y1="2" x2="14" y2="6" />
      <line x1="8" y1="10" x2="8" y2="14" />
      <line x1="16" y1="18" x2="16" y2="22" />
    </svg>
  )
}

function GroupIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.91a1 1 0 0 0 0-1.83Z" />
      <path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12" />
      <path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17" />
    </svg>
  )
}

function UserCircleIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <circle cx="12" cy="12" r="10" />
      <path d="M18 20a6 6 0 0 0-12 0" />
      <circle cx="12" cy="10" r="4" />
    </svg>
  )
}

function PlusIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </svg>
  )
}

function SearchIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  )
}

function CaretIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}

function PinIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" style={{ marginLeft: 2 }}>
      <path d="M12 17v5" />
      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1Z" />
    </svg>
  )
}

function PrIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <circle cx="6" cy="6" r="3" />
      <path d="M6 9v12" />
      <circle cx="18" cy="18" r="3" />
      <path d="M13 6h3a2 2 0 0 1 2 2v7" />
    </svg>
  )
}
