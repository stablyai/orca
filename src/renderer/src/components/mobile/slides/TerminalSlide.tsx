export function TerminalSlide(): React.JSX.Element {
  return (
    <div className="mp-device-screen">
      <div className="mp-session-chrome">
        <div className="mp-session-topbar">
          <button type="button" className="mp-session-back" aria-label="Back">
            <ChevronLeftIcon />
          </button>
          <div className="mp-session-title-block">
            <div className="mp-session-title">feat/mobile-page</div>
            <div className="mp-session-meta-row">
              <span className="mp-status-dot is-green" />
              <span>2 terminals · claude active</span>
            </div>
          </div>
          <button type="button" className="mp-session-iconbtn" aria-label="Source control">
            <BranchIcon />
          </button>
          <button type="button" className="mp-session-iconbtn" aria-label="Files">
            <FolderIcon />
          </button>
        </div>

        <div className="mp-session-tabbar">
          <div className="mp-session-tab is-active">claude</div>
          <div className="mp-session-tab">
            <span>shell</span>
          </div>
          <div className="mp-session-tab">
            <FileIcon />
            <span>PLAN.md</span>
          </div>
          <div className="mp-session-tab-add">
            <PlusIcon />
          </div>
        </div>
      </div>

      <div className="mp-terminal">
        <span className="mp-term-line">
          <span className="mp-term-prompt">dev@mac</span>{' '}
          <span className="mp-term-dim">orca/feat-mobile-page</span>{' '}
          <span className="mp-term-prompt">$</span> <span className="mp-term-cmd">claude</span>
        </span>
        <span className="mp-term-line" />
        <span className="mp-term-line">
          <span className="mp-term-tool">●</span> <span className="mp-term-mid">Read</span>{' '}
          <span className="mp-term-dim">mobile/orca-mobile-sidebar-mock-v3.html</span>
        </span>
        <span className="mp-term-line">
          {'  '}
          <span className="mp-term-comment">⎿ Read 2103 lines</span>
        </span>
        <span className="mp-term-line" />
        <span className="mp-term-line">
          <span className="mp-term-tool">●</span> <span className="mp-term-mid">Edit</span>{' '}
          <span className="mp-term-dim">mobile/orca-mobile-sidebar-mock-v3.html</span>
        </span>
        <span className="mp-term-line">
          {'  '}
          <span className="mp-term-comment">⎿ Replaced pair-scan slide with terminal session</span>
        </span>
        <span className="mp-term-line" />
        <span className="mp-term-line">
          <span className="mp-term-tool">●</span> <span className="mp-term-mid">Bash</span>{' '}
          <span className="mp-term-dim">pnpm test --filter mobile</span>
        </span>
        <span className="mp-term-line">
          {'  '}
          <span className="mp-term-comment">⎿ </span>
          <span className="mp-term-ok">PASS</span>
          <span className="mp-term-comment"> src/transport/host-store.test.ts</span>
        </span>
        <span className="mp-term-line">
          {'     '}
          <span className="mp-term-ok">PASS</span>
          <span className="mp-term-comment"> src/cache/worktree-cache.test.ts</span>
        </span>
        <span className="mp-term-line">
          {'     '}
          <span className="mp-term-warn">●</span>
          <span className="mp-term-comment"> 14 passed, 1 skipped (1.8s)</span>
        </span>
        <span className="mp-term-line" />
        <span className="mp-term-line">
          <span className="mp-term-mid">
            I&apos;ve replaced the pair-scan slide with a high-fidelity
          </span>
        </span>
        <span className="mp-term-line">
          <span className="mp-term-mid">
            terminal screen. Tokyonight palette, Menlo, real claude
          </span>
        </span>
        <span className="mp-term-line">
          <span className="mp-term-mid">tool-call formatting. Want me to add the diff next?</span>
        </span>
        <span className="mp-term-line" />
        <span className="mp-term-line">
          <span className="mp-term-prompt">›</span> <span className="mp-term-cursor" />
        </span>
      </div>

      <div className="mp-accessory-bar">
        <div className="mp-accessory-content">
          <div className="mp-accessory-key is-icon" aria-label="Switch to phone mode">
            <PhoneIcon />
          </div>
          <div className="mp-accessory-key">Paste</div>
          <div className="mp-accessory-key">Esc</div>
          <div className="mp-accessory-key">Tab</div>
          <div className="mp-accessory-key">⌫</div>
          <div className="mp-accessory-key">↑</div>
          <div className="mp-accessory-key">↓</div>
          <div className="mp-accessory-key">←</div>
          <div className="mp-accessory-key">→</div>
          <div className="mp-accessory-key">Ctrl+C</div>
          <div className="mp-accessory-key">Ctrl+L</div>
          <div className="mp-accessory-key is-icon is-add" aria-label="Add custom shortcut">
            <PlusIcon />
          </div>
        </div>
      </div>

      <div className="mp-input-bar">
        <div className="mp-text-input">Type a command…</div>
        <div className="mp-round-button" aria-label="Voice dictation">
          <MicIcon />
        </div>
        <div className="mp-round-button" aria-label="Send">
          <ArrowUpIcon />
        </div>
      </div>
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

function BranchIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <circle cx="6" cy="3" r="2.5" />
      <circle cx="6" cy="21" r="2.5" />
      <circle cx="18" cy="12" r="2.5" />
      <path d="M6 5.5v13" />
      <path d="M18 9.5a6 6 0 0 0-6-6" />
    </svg>
  )
}

function FolderIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <path d="M4 4h6l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z" />
    </svg>
  )
}

function FileIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
      <path d="M14 2v6h6" />
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

function PhoneIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
      <path d="M12 18h.01" />
    </svg>
  )
}

function MicIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="22" />
    </svg>
  )
}

function ArrowUpIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <path d="M12 19V5" />
      <path d="m5 12 7-7 7 7" />
    </svg>
  )
}
