import type { JSX, ReactNode } from 'react'
import { ClaudeIcon } from '@/components/status-bar/icons'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { FeatureWallClickRing } from './FeatureWallClickRing'
import { BrowserPricingStoryboard } from './BrowserPricingStoryboard'
import { BrowserSignupStoryboard } from './BrowserSignupStoryboard'
import {
  BROWSER_PROMPT_TEXT,
  browserPhaseAtLeast,
  isBrowserSplitPhase,
  type BrowserVisualState,
  type BrowserVisualTargetRefs
} from './browser-animated-visual-phase'

const TOUR_FLOATING_SURFACE_CLASS =
  'border border-black/14 bg-[rgba(255,255,255,0.82)] text-popover-foreground shadow-[0_16px_36px_rgba(0,0,0,0.24),inset_0_1px_0_rgba(255,255,255,0.14)] backdrop-blur-2xl dark:border-white/14 dark:bg-[rgba(0,0,0,0.72)] dark:shadow-[0_20px_44px_rgba(0,0,0,0.42),inset_0_1px_0_rgba(255,255,255,0.04)]'

export function BrowserStoryboardWindow(props: {
  state: BrowserVisualState
  targets: BrowserVisualTargetRefs
  newBrowserShortcutLabel: string
}): JSX.Element {
  const { state, targets } = props
  const { phase } = state
  const isIntroPhase =
    phase === 'idle' ||
    phase === 'newtab-approach' ||
    phase === 'newtab-click' ||
    phase === 'newtab-row-approach' ||
    phase === 'newtab-row-click'
  const browserChromeVisible = !isIntroPhase
  const newtabActive = phase === 'newtab-click' || phase === 'newtab-row-approach'
  const newtabRowActive = phase === 'newtab-row-approach'
  const dropdownVisible =
    phase === 'newtab-click' || phase === 'newtab-row-approach' || phase === 'newtab-row-click'
  const cursorVisible = (phase !== 'idle' && phase !== 'navigated') || state.clickRingVisible
  const ringStarter =
    phase === 'inspect' ||
    phase === 'annotate' ||
    phase === 'send-approach' ||
    phase === 'send-click' ||
    phase === 'handoff'
  const annotateOpen = phase === 'annotate' || phase === 'send-approach' || phase === 'send-click'
  const isSplit = isBrowserSplitPhase(phase)
  const showSignup =
    phase === 'navigated' ||
    phase === 'screenshot-line' ||
    phase === 'screenshot-flash' ||
    phase === 'verified'

  return (
    <div className="relative flex min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-xs">
      <div
        ref={targets.titlebarRef}
        className="relative flex min-h-[32px] items-end gap-1.5 border-b border-border bg-muted/40 px-2.5 pt-2"
      >
        <div className="ml-1 flex flex-1 items-end gap-1 overflow-visible">
          <BrowserTab
            minimized={!isIntroPhase}
            icon={<TerminalGlyph />}
            title={translate(
              'auto.components.feature.wall.BrowserAnimatedVisual.04096318ab',
              'Terminal 1'
            )}
          />
          {!isIntroPhase ? (
            <BrowserTab
              incoming
              icon={<GlobeGlyph />}
              title={translate(
                'auto.components.feature.wall.BrowserAnimatedVisual.7da6eed7bf',
                'localhost:3000'
              )}
            />
          ) : null}
          <span
            ref={targets.newtabButtonRef}
            className={cn(
              'mb-1 inline-flex size-[22px] items-center justify-center rounded-md text-muted-foreground transition-colors duration-150',
              newtabActive ? 'bg-foreground/10 text-foreground' : null
            )}
          >
            <PlusGlyph />
          </span>
        </div>
        <div
          aria-hidden={!dropdownVisible}
          className={cn(
            'absolute z-40 origin-top-left rounded-[10px] p-1 text-[11.5px] transition-[opacity,transform] duration-150',
            TOUR_FLOATING_SURFACE_CLASS,
            dropdownVisible
              ? 'translate-y-0 scale-100 opacity-100'
              : '-translate-y-[3px] scale-[0.985] opacity-0'
          )}
          style={{
            top: 'calc(100% + 4px)',
            left: state.menuOffsetX,
            minWidth: 196
          }}
        >
          <DropdownSkeletonRow widthPct={64} />
          <div
            ref={targets.newtabRowRef}
            className={cn(
              'grid items-center gap-2 rounded-md px-2 py-[5px]',
              newtabRowActive ? 'bg-black/8 dark:bg-white/14' : null
            )}
            style={{ gridTemplateColumns: '18px 1fr' }}
          >
            <span className="inline-flex size-[13px] items-center justify-center text-popover-foreground">
              <GlobeGlyph />
            </span>
            <span className="text-[11.5px] text-popover-foreground">
              {translate(
                'auto.components.feature.wall.BrowserAnimatedVisual.0a2bd01c02',
                'New Browser Tab'
              )}
            </span>
            <span className="font-mono text-[10.5px] text-muted-foreground">
              {props.newBrowserShortcutLabel}
            </span>
          </div>
          <DropdownSkeletonRow widthPct={52} />
        </div>
      </div>

      <div
        className="flex items-center gap-2 border-b border-border bg-muted/20 px-2.5 py-1.5"
        style={{ visibility: browserChromeVisible ? 'visible' : 'hidden' }}
      >
        <span className="inline-flex gap-1 text-muted-foreground">
          <NavGlyph>‹</NavGlyph>
          <NavGlyph>›</NavGlyph>
          <NavGlyph>↻</NavGlyph>
        </span>
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden rounded-md border border-border bg-card px-2 py-[3px] font-mono text-[11px]">
          {isSplit ? (
            <span className="truncate text-muted-foreground transition-colors duration-200">
              {`...${showSignup ? '/signup' : '/pricing'}`}
            </span>
          ) : (
            <>
              <span className="truncate text-foreground">
                {translate(
                  'auto.components.feature.wall.BrowserAnimatedVisual.7da6eed7bf',
                  'localhost:3000'
                )}
              </span>
              <span className="truncate text-muted-foreground transition-colors duration-200">
                {showSignup
                  ? translate(
                      'auto.components.feature.wall.BrowserAnimatedVisual.f39be6ca14',
                      '/signup'
                    )
                  : translate(
                      'auto.components.feature.wall.BrowserAnimatedVisual.73bbb46073',
                      '/pricing'
                    )}
              </span>
            </>
          )}
        </div>
      </div>

      <div
        className="relative flex-1 bg-card"
        style={{ overflow: isIntroPhase ? 'visible' : 'hidden', minHeight: 0 }}
      >
        <div
          ref={targets.browserPageRef}
          className="relative flex flex-col gap-3 px-5 py-4"
          style={{ visibility: browserChromeVisible ? 'visible' : 'hidden' }}
        >
          {showSignup ? (
            <BrowserSignupStoryboard />
          ) : (
            <BrowserPricingStoryboard
              cardRef={targets.starterCardRef}
              ctaRef={targets.ctaRef}
              ringStarter={ringStarter}
              ctaHighlighted={browserPhaseAtLeast(phase, 'updated')}
              ctaPressing={phase === 'click-press'}
            />
          )}

          <div
            aria-hidden={!annotateOpen}
            className={cn(
              'pointer-events-none absolute z-30 flex origin-top-left flex-col gap-1.5 rounded-md px-[9px] pb-[7px] pt-2 text-[10px] transition-[opacity,transform] duration-200',
              TOUR_FLOATING_SURFACE_CLASS,
              annotateOpen ? 'scale-100 opacity-100' : 'scale-[0.96] opacity-0'
            )}
            style={{ left: state.annotateAnchor.left, top: state.annotateAnchor.top, width: 188 }}
          >
            <span className="block w-full shrink-0 truncate font-mono text-[9.5px] leading-none text-muted-foreground">
              {translate(
                'auto.components.feature.wall.BrowserAnimatedVisual.d8856b604a',
                'div.pricing-grid > div.card.starter:nth-of-type(1) > a.cta'
              )}
            </span>
            <span aria-hidden className="h-px w-full shrink-0 bg-popover-foreground/10" />
            <div className="min-h-[28px] flex-1 break-words font-sans text-[10px] leading-[1.35] text-popover-foreground">
              {state.typedChars > 0 ? (
                <>
                  {BROWSER_PROMPT_TEXT.slice(0, state.typedChars)}
                  <span className="ml-px inline-block h-2 w-px translate-y-[1px] bg-popover-foreground align-baseline" />
                </>
              ) : (
                <span className="text-muted-foreground">
                  {translate(
                    'auto.components.feature.wall.BrowserAnimatedVisual.3d2352f94b',
                    'Describe the change…'
                  )}
                </span>
              )}
            </div>
            <div className="flex justify-end">
              <span
                ref={targets.sendButtonRef}
                aria-label={translate(
                  'auto.components.feature.wall.BrowserAnimatedVisual.0f8481e1a7',
                  'Send to Claude'
                )}
                className={cn(
                  'inline-flex size-5 shrink-0 items-center justify-center rounded border border-border bg-muted text-foreground transition-[background-color,transform] duration-150',
                  phase === 'send-click' ? 'scale-[0.92] bg-foreground/[0.12]' : null
                )}
              >
                <ClaudeIcon size={12} />
              </span>
            </div>
          </div>

          <span
            key={state.flashKey}
            aria-hidden
            className={cn(
              'pointer-events-none absolute inset-0 z-40 bg-background/85 dark:bg-foreground/12',
              phase === 'screenshot-flash'
                ? 'animate-[browserFlash_360ms_ease-out_forwards]'
                : 'opacity-0'
            )}
          />
        </div>
        <div
          aria-hidden
          className={cn(
            'pointer-events-none absolute left-0 top-0 z-50 transition-[opacity,transform] duration-700 ease-[cubic-bezier(.45,.05,.2,1)]',
            cursorVisible ? 'opacity-100' : 'opacity-0'
          )}
          style={{
            transform: `translate(${state.cursorPosition.x}px, ${state.cursorPosition.y}px)`
          }}
        >
          <div className="relative">
            <CursorIcon />
            {state.clickRingVisible ? <FeatureWallClickRing key={state.clickRingKey} /> : null}
          </div>
        </div>
      </div>
    </div>
  )
}

function BrowserTab(props: {
  icon: ReactNode
  title: string
  minimized?: boolean
  incoming?: boolean
}): JSX.Element {
  return (
    <span
      className={cn(
        'relative inline-flex shrink-0 items-center gap-1.5 rounded-t-md border border-b-0 border-border bg-card px-2.5 pb-1.5 pt-1 text-[11px] text-foreground',
        props.minimized ? 'gap-0 px-2' : null,
        props.incoming ? 'animate-[browserTabIn_320ms_cubic-bezier(.2,.8,.2,1)_both]' : null
      )}
      style={{ top: 1 }}
    >
      <span className="inline-flex size-3 items-center justify-center text-muted-foreground">
        {props.icon}
      </span>
      {props.minimized ? null : (
        <span className="whitespace-nowrap text-[11px] text-foreground">{props.title}</span>
      )}
    </span>
  )
}

function DropdownSkeletonRow(props: { widthPct: number }): JSX.Element {
  return (
    <div
      className="grid items-center gap-2 rounded-md px-2 py-[5px]"
      style={{ gridTemplateColumns: '18px 1fr' }}
    >
      <span className="size-[13px] rounded-[3px] bg-popover-foreground/10" />
      <span
        className="h-[7px] rounded-[3px] bg-popover-foreground/10"
        style={{ width: `${props.widthPct}%` }}
      />
    </div>
  )
}

function NavGlyph(props: { children: ReactNode }): JSX.Element {
  return (
    <span className="inline-flex size-[18px] items-center justify-center rounded text-muted-foreground">
      {props.children}
    </span>
  )
}

function PlusGlyph(): JSX.Element {
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M8 3v10M3 8h10" />
    </svg>
  )
}

function TerminalGlyph(): JSX.Element {
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="m4 6 2.5 2L4 10" />
      <path d="M8.5 11h3.5" />
    </svg>
  )
}

function GlobeGlyph(): JSX.Element {
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      aria-hidden
    >
      <circle cx={8} cy={8} r={5.5} />
      <path d="M2.5 8h11M8 2.5c2 1.7 2 9.3 0 11M8 2.5c-2 1.7-2 9.3 0 11" />
    </svg>
  )
}

function CursorIcon(): JSX.Element {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 16 16"
      aria-hidden
      focusable="false"
      className="drop-shadow-[0_1px_1px_rgba(0,0,0,0.35)]"
    >
      <path
        d="M2 1.5 L2 12 L5 9 L7.2 14.5 L9.5 13.6 L7.3 8 L11.5 8 Z"
        fill="#fff"
        stroke="#18181b"
        strokeWidth={1}
        strokeLinejoin="round"
      />
    </svg>
  )
}
