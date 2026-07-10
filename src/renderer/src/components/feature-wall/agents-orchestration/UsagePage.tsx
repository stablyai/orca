/* oxlint-disable react-doctor/no-adjust-state-on-prop-change -- Why: this page is a timed storyboard; phase state intentionally advances from animation effects and reduced-motion gates. */
import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import { ClaudeIcon, OpenAIIcon } from '../../status-bar/icons'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'

type Phase = 'reset' | 'expanded' | 'targeted' | 'swapped'

const EXPAND_DELAY = 2200
const TARGET_DELAY = 3400
const SWAP_DELAY = 4400
const LOOP_DELAY = 7800

export function UsagePage(props: { active: boolean; reducedMotion: boolean }): JSX.Element {
  const { active, reducedMotion } = props
  const [phase, setPhase] = useState<Phase>('reset')
  const [pulseKey, setPulseKey] = useState(0)

  useEffect(() => {
    if (!active) {
      setPhase('reset')
      return
    }
    if (reducedMotion) {
      setPhase('swapped')
      return
    }
    let cancelled = false
    const timeouts: number[] = []
    const at = (delay: number, fn: () => void): void => {
      timeouts.push(
        window.setTimeout(() => {
          if (!cancelled) {
            fn()
          }
        }, delay)
      )
    }
    const loop = (): void => {
      setPhase('reset')
      at(EXPAND_DELAY, () => setPhase('expanded'))
      at(TARGET_DELAY, () => setPhase('targeted'))
      at(SWAP_DELAY, () => {
        setPhase('swapped')
        setPulseKey((k) => k + 1)
      })
      at(LOOP_DELAY, () => {
        if (!cancelled) {
          loop()
        }
      })
    }
    loop()
    return () => {
      cancelled = true
      timeouts.forEach((id) => window.clearTimeout(id))
    }
  }, [active, reducedMotion])

  const swapped = phase === 'swapped'
  const expanded = phase === 'expanded' || phase === 'targeted' || phase === 'swapped'
  const targeted = phase === 'targeted' || phase === 'swapped'

  return (
    <div className="relative h-full w-full">
      <Popover expanded={expanded} targeted={targeted} swapped={swapped} pulseKey={pulseKey} />
      <BottomBar swapped={swapped} />
    </div>
  )
}

function Popover(props: {
  expanded: boolean
  targeted: boolean
  swapped: boolean
  pulseKey: number
}): JSX.Element {
  const { expanded, targeted, swapped, pulseKey } = props
  const sessionPctText = swapped ? '100% left' : '4% left'
  const sessionResetText = swapped ? 'Resets in 5h' : 'Resets in 47m'
  const sessionFillWidth = swapped ? '100%' : '4%'
  const weeklyFillWidth = '62%'

  return (
    <div
      className={cn(
        'absolute z-10 flex flex-col gap-[7px] rounded-[10px] border bg-card px-3 py-2.5 not-italic',
        'border-border text-foreground',
        'shadow-[0_16px_38px_rgba(24,24,27,0.18),0_2px_6px_rgba(24,24,27,0.08)]'
      )}
      style={{ left: 40, bottom: 70, width: 320 }}
    >
      <div className="grid grid-cols-[24px_minmax(0,1fr)] items-center gap-2.5">
        <span className="inline-flex size-6 items-center justify-center rounded-[5px] bg-foreground/[0.06] text-foreground">
          <span className="inline-flex" style={{ color: '#111' }}>
            <OpenAIIcon size={14} />
          </span>
        </span>
        <div>
          <div className="text-[13.5px] font-bold leading-[1.1]">
            {translate(
              'auto.components.feature.wall.agents.orchestration.UsagePage.6a4b1d3c38',
              'Codex'
            )}
          </div>
          <div className="text-[11px] text-muted-foreground">
            {translate(
              'auto.components.feature.wall.agents.orchestration.UsagePage.5e45fb1238',
              'Updated 1m ago'
            )}
          </div>
        </div>
      </div>

      <UsageBar
        title={translate(
          'auto.components.feature.wall.agents.orchestration.UsagePage.f421abf962',
          'Session'
        )}
        fillWidth={sessionFillWidth}
        warn={!swapped}
        metaLeft={
          <span
            key={`pct-${pulseKey}-${swapped ? 'on' : 'off'}`}
            className={cn(
              'font-semibold',
              swapped ? 'feature-wall-meta-pulse' : 'text-[rgb(220_38_38)]'
            )}
          >
            {sessionPctText}
          </span>
        }
        metaRight={<span>{sessionResetText}</span>}
      />
      <UsageBar
        title={translate(
          'auto.components.feature.wall.agents.orchestration.UsagePage.0470aaed99',
          'Weekly'
        )}
        fillWidth={weeklyFillWidth}
        warn={false}
        metaLeft={
          <span>
            {translate(
              'auto.components.feature.wall.agents.orchestration.UsagePage.05ce4ecdd3',
              '62% left'
            )}
          </span>
        }
        metaRight={
          <span>
            {translate(
              'auto.components.feature.wall.agents.orchestration.UsagePage.4dce5ca3aa',
              'Resets in 4d 3h'
            )}
          </span>
        }
      />
      <div className="h-px bg-border" />
      <div className="text-[11px] font-semibold">
        {translate(
          'auto.components.feature.wall.agents.orchestration.UsagePage.277a9c65a9',
          'Codex Account'
        )}
      </div>
      <div className="flex items-center justify-between text-[11px]">
        <AccountNameSkeleton widthClassName={swapped ? 'w-24' : 'w-28'} />
        <span
          className={cn(
            'inline-flex items-center justify-center text-muted-foreground transition-transform duration-[240ms] ease-[cubic-bezier(.2,.8,.2,1)]',
            expanded ? 'rotate-90' : 'rotate-0'
          )}
          aria-hidden
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <path
              d="M3 2 L7 5 L3 8"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </div>
      <div
        className={cn(
          '-mt-px grid transition-[grid-template-rows] duration-[280ms] ease-[cubic-bezier(.2,.8,.2,1)]',
          expanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
        )}
      >
        <div className="overflow-hidden min-h-0">
          <div className="pb-1 pt-1 text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
            {translate(
              'auto.components.feature.wall.agents.orchestration.UsagePage.be5a165875',
              'Switch to'
            )}
          </div>
          <div className="flex flex-col gap-0.5 rounded-lg border border-border bg-foreground/[0.025] p-[3px]">
            <SwitchAccount
              accountWidthClassName="w-24"
              tag="Team"
              fillPct={100}
              metaText="100%"
              highlighted={targeted}
            />
            <SwitchAccount
              accountWidthClassName="w-32"
              tag={null}
              fillPct={78}
              metaText="78%"
              highlighted={false}
            />
          </div>
        </div>
      </div>
      <div
        className="absolute bottom-[-5px] left-1/2 size-[10px] -ml-[5px] rotate-45 border-b border-r border-border bg-card"
        aria-hidden
      />
    </div>
  )
}

function AccountNameSkeleton(props: { widthClassName: string }): JSX.Element {
  return (
    <span className={cn('block h-2.5 rounded-full bg-foreground/[0.14]', props.widthClassName)} />
  )
}

function UsageBar(props: {
  title: string
  fillWidth: string
  warn: boolean
  metaLeft: JSX.Element
  metaRight: JSX.Element
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-[12px] font-semibold">{props.title}</div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-foreground/[0.08]">
        <span
          className={cn(
            'block h-full rounded-full transition-[width,background] duration-[800ms] ease-[cubic-bezier(.2,.8,.2,1)]',
            props.warn ? 'bg-[rgb(239_68_68)]' : 'bg-[rgb(34_197_94)]'
          )}
          style={{ width: props.fillWidth }}
        />
      </div>
      <div className="flex justify-between font-mono text-[11px] text-muted-foreground">
        {props.metaLeft}
        {props.metaRight}
      </div>
    </div>
  )
}

function SwitchAccount(props: {
  accountWidthClassName: string
  tag: string | null
  fillPct: number
  metaText: string
  highlighted: boolean
}): JSX.Element {
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-2.5 rounded-md px-1.5 py-1 text-[11.5px] transition-colors duration-[160ms]',
        props.highlighted ? 'bg-emerald-500/10' : 'bg-transparent'
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <AccountNameSkeleton widthClassName={props.accountWidthClassName} />
        {props.tag ? (
          <span className="shrink-0 rounded-full bg-foreground/[0.06] px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
            {props.tag}
          </span>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <span className="block h-1 w-11 overflow-hidden rounded-full bg-foreground/[0.10]">
          <span
            className="block h-full rounded-full bg-emerald-500"
            style={{ width: `${props.fillPct}%` }}
          />
        </span>
        <span className="min-w-7 text-right font-mono text-[10px] text-muted-foreground">
          {props.metaText}
        </span>
      </div>
    </div>
  )
}

// The 340px-wide light pill at the bottom of the panel that the popover tip
// points down to. Codex chip is the "active" one — it animates from a near-
// empty red bar to a full green bar after the account swap.
function BottomBar(props: { swapped: boolean }): JSX.Element {
  const codexFillWidth = props.swapped ? '100%' : '4%'
  const codexFillColor = props.swapped ? 'rgb(34 197 94)' : 'rgb(239 68 68)'
  const codexMeta = props.swapped ? '100% 5h · 96% wk' : '4% 47m'
  return (
    <div
      className="absolute bottom-[22px] left-1/2 flex -translate-x-1/2 items-center gap-3.5 rounded-lg border border-border bg-muted/60 px-3.5 py-1.5 text-[11px] shadow-[0_1px_2px_rgba(24,24,27,0.04)]"
      style={{ width: 340 }}
    >
      <div className="inline-flex items-center gap-1.5 font-mono text-[10.5px] text-muted-foreground">
        <ClaudeIcon size={12} />
        <span className="block h-1 w-9 overflow-hidden rounded-full bg-foreground/[0.12]">
          <span className="block h-full rounded-full bg-emerald-500" style={{ width: '71%' }} />
        </span>
        <span>
          {translate(
            'auto.components.feature.wall.agents.orchestration.UsagePage.64265cb295',
            '71% 5h'
          )}
        </span>
      </div>
      <div className="-my-0.5 inline-flex items-center gap-1.5 rounded-md bg-foreground/[0.06] px-1.5 py-0.5 font-mono text-[10.5px] text-foreground">
        <span style={{ color: '#111' }}>
          <OpenAIIcon size={12} />
        </span>
        <span className="block h-1 w-9 overflow-hidden rounded-full bg-foreground/[0.12]">
          <span
            className="block h-full rounded-full transition-[width,background] duration-[600ms] ease-out"
            style={{ width: codexFillWidth, background: codexFillColor }}
          />
        </span>
        <span>{codexMeta}</span>
      </div>
    </div>
  )
}
