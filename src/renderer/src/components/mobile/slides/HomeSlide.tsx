import { ClaudeIcon, OpenAIIcon } from '../../status-bar/icons'
import { cn } from '../../../lib/utils'

export function HomeSlide({ tapping }: { tapping: boolean }): React.JSX.Element {
  return (
    <div className="mp-device-screen">
      <div className="mp-app-topbar">
        <div className="mp-app-brand">
          <OrcaLogo />
          <span className="mp-app-brand-name">Orca</span>
        </div>
        <button type="button" className="mp-icon-button" aria-label="Settings">
          <SettingsIcon />
        </button>
      </div>

      <div className="mp-scroll-region">
        <div className="mp-greeting">
          <div className="mp-greeting-title">Welcome back</div>
        </div>

        <div className="mp-stat-row">
          <Stat value="1,284" label="Agents spawned" />
          <Stat value="142h" label="Agent time" />
          <Stat value="96" label="PRs created" />
        </div>

        <div className="mp-section-label">Desktops</div>
        <div className={cn('mp-host-card', tapping && 'is-tapping')}>
          <div className="mp-host-icon">
            <DesktopIcon />
          </div>
          <div className="mp-host-main">
            <div className="mp-host-name">MacBook Pro</div>
            <div className="mp-host-meta">
              <span className="mp-status-dot is-green" />
              <span>Connected · 40 worktrees · 5 active</span>
            </div>
          </div>
          <div className="mp-chevron-right">
            <ChevronIcon />
          </div>
        </div>
        <div className="mp-host-card">
          <div className="mp-host-icon is-dim">
            <DesktopIcon />
          </div>
          <div className="mp-host-main">
            <div className="mp-host-name is-dim">M1 Mini · home</div>
            <div className="mp-host-meta">
              <span className="mp-status-dot is-muted" />
              <span>Disconnected</span>
            </div>
          </div>
          <div className="mp-chevron-right">
            <ChevronIcon />
          </div>
        </div>

        <div className="mp-section-label" style={{ marginTop: 14 }}>
          Resume
        </div>
        <div className="mp-resume-card">
          <div className="mp-resume-icon">
            <ResumeIcon />
          </div>
          <div className="mp-host-main">
            <div className="mp-resume-title">feat/mobile-page</div>
            <div className="mp-resume-sub">
              <span className="mp-repo-dot" style={{ background: '#3b82f6' }} />
              <span>orca&nbsp;&nbsp;·&nbsp;&nbsp;feat/mobile-page</span>
            </div>
          </div>
          <div className="mp-chevron-right">
            <ChevronIcon />
          </div>
        </div>

        <div className="mp-section-label" style={{ marginTop: 10 }}>
          Tasks
        </div>
        <div className="mp-task-home-card">
          <div className="mp-task-home-icon">
            <ListTodoIcon />
          </div>
          <div className="mp-host-main">
            <div className="mp-task-home-title">Tasks</div>
            <div className="mp-task-home-subtitle">GitHub · Linear</div>
          </div>
          <div className="mp-task-home-providers" aria-label="GitHub and Linear">
            <div className="mp-task-home-provider-button">
              <GithubIcon />
            </div>
            <div className="mp-task-home-provider-button">
              <LinearIcon />
            </div>
          </div>
          <div className="mp-chevron-right">
            <ChevronIcon />
          </div>
        </div>

        <div className="mp-section-label" style={{ marginTop: 14 }}>
          Quick Actions
        </div>
        <div className="mp-quick-actions">
          <div className="mp-quick-action">
            <div className="mp-quick-action-icon">
              <QrSmallIcon />
            </div>
            <div className="mp-quick-action-label">Pair Desktop</div>
          </div>
          <div className="mp-quick-action">
            <div className="mp-quick-action-icon">
              <PlusIcon />
            </div>
            <div className="mp-quick-action-label">New Workspace</div>
          </div>
        </div>

        <div className="mp-section-label" style={{ marginTop: 14 }}>
          Account usage
        </div>
        <div className="mp-accounts-card">
          <AccountRow
            icon={<ClaudeIcon size={18} />}
            email="claude@stably.ai"
            sessionPct={42}
            weekPct={18}
          />
          <AccountRow
            icon={<OpenAIIcon size={18} />}
            email="codex@stably.ai"
            sessionPct={67}
            weekPct={31}
          />
        </div>
      </div>
    </div>
  )
}

function Stat({ value, label }: { value: string; label: string }): React.JSX.Element {
  return (
    <div className="mp-stat-card">
      <div className="mp-stat-value">{value}</div>
      <div className="mp-stat-label">{label}</div>
    </div>
  )
}

function AccountRow({
  icon,
  email,
  sessionPct,
  weekPct
}: {
  icon: React.ReactNode
  email: string
  sessionPct: number
  weekPct: number
}): React.JSX.Element {
  return (
    <div className="mp-accounts-row">
      <div className="mp-accounts-icon">{icon}</div>
      <div className="mp-accounts-info">
        <div className="mp-accounts-email">{email}</div>
        <div className="mp-accounts-bars">
          <UsageBar label="5h" pct={sessionPct} />
          <UsageBar label="7d" pct={weekPct} />
        </div>
      </div>
    </div>
  )
}

function UsageBar({ label, pct }: { label: string; pct: number }): React.JSX.Element {
  return (
    <div className="mp-usage-bar">
      <div className="mp-usage-bar-label">{label}</div>
      <div className="mp-usage-bar-track">
        <div className="mp-usage-bar-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

function OrcaLogo(): React.JSX.Element {
  return (
    <svg className="mp-orca-logo" viewBox="0 0 318.60232 202.66667" fill="currentColor" aria-hidden>
      <g transform="translate(-6.6666669,-70.666669)">
        <path d="m 177.81311,248.33334 c 23.82304,-41.29793 40.54045,-66.84626 49.51207,-75.66667 6.81685,-6.70196 10.07373,-8.7374 20.07265,-12.54475 34.57822,-13.16655 61.04674,-26.78733 72.37222,-37.24295 9.62924,-8.88966 9.34286,-9.01142 -23.43671,-9.964 -35.71756,-1.03796 -43.72989,0.42119 -62.17546,11.323 -16.72118,9.88265 -34.20103,30.11225 -42.74704,49.47157 -2.57353,5.82985 -14.81294,44.3056 -27.96399,87.90747 -2.86036,9.48343 -3.02466,11.71633 -0.86213,11.71633 0.44382,0 7.29659,-11.25 15.22839,-25 z m -65.14644,-8.32267 C 120,239.3326 130.5,237.50979 136,235.95998 c 5.5,-1.5498 12.25,-3.13783 15,-3.52895 2.75,-0.39111 5,-0.95485 5,-1.25275 0,-0.29789 2.15135,-7.58487 4.78078,-16.19328 8.49209,-27.80201 12.21334,-40.41629 21.13747,-71.65166 4.81891,-16.86667 11.23502,-39.185 14.25802,-49.596301 5.12803,-17.66103 5.74763,-23.07037 2.64253,-23.07037 -1.84887,0 -4.07048,6.908293 -16.72243,52.000001 -21.78975,77.65896 -20.80806,74.74393 -26.84794,79.72251 -7.5925,6.25838 -25.03916,14.82524 -36.10856,17.73044 -17.0947,4.48656 -33.410599,3.86724 -53.116765,-2.01622 -18.569242,-5.54403 -23.142662,-5.80284 -33.639754,-1.9037 -5.875424,2.18242 -9.864152,5.04363 -16.716684,11.99127 -4.95,5.0187 -9.0000001,10.02884 -9.0000001,11.13364 0,1.75174 5.9276921,2.00299 46.3333351,1.96383 25.483334,-0.0247 52.333338,-0.59969 59.666668,-1.27777 z M 252.69513,104.63708 c 12.18267,-3.48651 15.77304,-7.895503 9.63821,-11.835773 -10.19296,-6.546726 -36.19849,-1.77301 -41.19436,7.561863 -1.2556,2.3461 -0.98698,3.2037 1.68353,5.375 2.69471,2.19098 4.59991,2.47691 12.53928,1.88189 5.14899,-0.3859 12.94899,-1.72824 17.33334,-2.98298 z" />
      </g>
    </svg>
  )
}

function SettingsIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
    </svg>
  )
}

function DesktopIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8" />
      <path d="M12 17v4" />
    </svg>
  )
}

function ChevronIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <path d="m9 18 6-6-6-6" />
    </svg>
  )
}

function ResumeIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <path d="m4 17 6-6-6-6" />
      <path d="M12 19h8" />
    </svg>
  )
}

function ListTodoIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <rect x="3" y="5" width="6" height="6" rx="1" />
      <path d="m3 17 2 2 4-4" />
      <path d="M13 6h8" />
      <path d="M13 12h8" />
      <path d="M13 18h8" />
    </svg>
  )
}

function GithubIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.4 5.4 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" />
      <path d="M9 18c-4.51 2-5-2-7-2" />
    </svg>
  )
}

function LinearIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 100 100" fill="currentColor" aria-hidden>
      <path d="M1.225 61.523c-.187-.738.708-1.235 1.246-.697l36.703 36.703c.538.538.041 1.433-.697 1.246C20.6 94.16 5.84 79.4 1.225 61.523ZM.002 46.811a.997.997 0 0 0 .291.749l52.147 52.147a.998.998 0 0 0 .749.291 50.328 50.328 0 0 0 9.235-1.119c.667-.149.904-.972.422-1.454L1.575 37.154c-.482-.482-1.305-.245-1.454.422A50.328 50.328 0 0 0 .002 46.81Zm4.528-18.34a.998.998 0 0 0 .195 1.144l64.66 64.66a.998.998 0 0 0 1.144.195 50.45 50.45 0 0 0 5.913-3.46.999.999 0 0 0 .14-1.518L9.51 22.418a.999.999 0 0 0-1.518.14 50.45 50.45 0 0 0-3.46 5.913Zm10.435-13.075a.999.999 0 0 0 .002 1.41l68.226 68.226a.999.999 0 0 0 1.41.002c19.292-19.477 19.234-50.97-.176-70.378-19.410-19.410-50.901-19.468-70.378-.176-1.061 1.044.916 1.916.916 1.916Z" />
    </svg>
  )
}

function QrSmallIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="3" height="3" />
      <rect x="18" y="14" width="3" height="3" />
      <rect x="14" y="18" width="3" height="3" />
      <rect x="18" y="18" width="3" height="3" />
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
