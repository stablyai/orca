import { cn } from '../../../lib/utils'
import { translate } from '@/i18n/i18n'

type AgentIndicator = 'waiting' | 'done' | 'working' | 'idle'

type JumpBackInRowProps = {
  indicator: AgentIndicator
  name: string
  status: string
  desktop: string
  time: string
}

const AGENT_DOT: Record<Exclude<AgentIndicator, 'working'>, string> = {
  waiting: 'is-red',
  done: 'is-green',
  idle: 'is-muted'
}

// Waiting and done ask something of the user, so only they tint the status word (mobile parity).
const STATUS_TONE: Partial<Record<AgentIndicator, string>> = {
  waiting: 'is-waiting',
  done: 'is-done'
}

export function HomeSlide({ tapping }: { tapping: boolean }): React.JSX.Element {
  const macbookPro = translate('auto.components.mobile.slides.HomeSlide.19c212e25e', 'MacBook Pro')
  return (
    <div className="mp-device-screen">
      <div className="mp-app-topbar">
        <div className="mp-app-brand">
          <OrcaLogo />
          <span className="mp-app-brand-name">
            {translate('auto.components.mobile.slides.HomeSlide.5d94e8ddcc', 'Orca')}
          </span>
        </div>
        <button
          type="button"
          className="mp-icon-button"
          aria-label={translate('auto.components.mobile.slides.HomeSlide.af761a0c0d', 'Settings')}
        >
          <SettingsIcon />
        </button>
      </div>

      <div className="mp-scroll-region">
        <div className="mp-home-heading is-first">
          {translate('auto.components.mobile.slides.HomeSlide.dc1f3f5535', 'Jump back in')}
        </div>
        <div className="mp-home-group">
          <JumpBackInRow
            indicator="waiting"
            name="fix-auth-redirect"
            status={translate(
              'auto.components.mobile.slides.HomeSlide.c2a0215163',
              'Waiting for input'
            )}
            desktop={macbookPro}
            time={translate('auto.components.mobile.slides.HomeSlide.0c14dac908', '2m')}
          />
          <JumpBackInRow
            indicator="done"
            name="tasks-sheet-polish"
            status={translate('auto.components.mobile.slides.HomeSlide.77c0dae863', 'Done')}
            desktop={translate('auto.components.mobile.slides.HomeSlide.b5308d5e2c', 'M1 Mini')}
            time={translate('auto.components.mobile.slides.HomeSlide.3166f865af', '14m')}
          />
          <JumpBackInRow
            indicator="working"
            name="relay-reconnect-backoff"
            status={translate('auto.components.mobile.slides.HomeSlide.609517273b', 'Working')}
            desktop={macbookPro}
            time={translate('auto.components.mobile.slides.HomeSlide.005afbad3d', 'now')}
          />
          <JumpBackInRow
            indicator="idle"
            name="feat/mobile-page"
            status={translate('auto.components.mobile.slides.HomeSlide.e986b282af', 'Last opened')}
            desktop={macbookPro}
            time={translate('auto.components.mobile.slides.HomeSlide.8a3ebdbdac', '1h')}
          />
        </div>

        <div className="mp-home-heading">
          {translate('auto.components.mobile.slides.HomeSlide.2f1a1d10c4', 'Desktops')}
        </div>
        <div className="mp-home-group">
          {/* The carousel's next slide is this desktop's worktree list, so the tap lands here. */}
          <div className={cn('mp-home-row', tapping && 'is-tapping')}>
            <div className="mp-home-status">
              <span className="mp-status-dot is-green" />
            </div>
            <div className="mp-home-text">
              <div className="mp-home-title">{macbookPro}</div>
              <div className="mp-home-subtitle">
                {translate(
                  'auto.components.mobile.slides.HomeSlide.04a94cadee',
                  '40 worktrees · 5 active'
                )}
              </div>
            </div>
            <div className="mp-home-trailing">
              <ChevronIcon />
            </div>
          </div>
          <div className="mp-home-row">
            <div className="mp-home-status">
              <span className="mp-status-dot is-muted" />
            </div>
            <div className="mp-home-text">
              <div className="mp-home-title">
                {translate('auto.components.mobile.slides.HomeSlide.b5308d5e2c', 'M1 Mini')}
              </div>
              <div className="mp-home-subtitle">
                {translate('auto.components.mobile.slides.HomeSlide.cf3f98fa3f', 'Disconnected')}
              </div>
            </div>
            <div className="mp-home-trailing">
              <ChevronIcon />
            </div>
          </div>
          <div className="mp-home-action-row">
            <PlusIcon />
            {translate('auto.components.mobile.slides.HomeSlide.aefd110ea5', 'Pair a desktop')}
          </div>
        </div>
      </div>

      <div className="mp-home-bottom-bar">
        <div className="mp-home-bar-button is-secondary">
          <ListTodoIcon />
          <span>{translate('auto.components.mobile.slides.HomeSlide.a4c3f7b7aa', 'Tasks')}</span>
        </div>
        <div className="mp-home-bar-button is-primary">
          <PlusIcon />
          <span>
            {translate('auto.components.mobile.slides.HomeSlide.d08ee9c466', 'New workspace')}
          </span>
        </div>
      </div>
    </div>
  )
}

function JumpBackInRow({
  indicator,
  name,
  status,
  desktop,
  time
}: JumpBackInRowProps): React.JSX.Element {
  return (
    <div className="mp-home-row">
      <div className="mp-home-status">
        {indicator === 'working' ? (
          <div className="mp-wl-spinner" />
        ) : (
          <div className={cn('mp-wl-dot', AGENT_DOT[indicator])} />
        )}
      </div>
      <div className="mp-home-text">
        <div className="mp-home-title">{name}</div>
        <div className="mp-home-subtitle">
          <span className={STATUS_TONE[indicator]}>{status}</span> · {desktop}
        </div>
      </div>
      <div className="mp-home-trailing">
        {time}
        <ChevronIcon />
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

function ChevronIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <path d="m9 18 6-6-6-6" />
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

function PlusIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </svg>
  )
}
