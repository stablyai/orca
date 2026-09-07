import type { JSX, RefObject } from 'react'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'

function SplitRightIcon(): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width={12}
      height={12}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      aria-hidden
    >
      <rect x={2.5} y={3} width={11} height={10} rx={1.4} />
      <path d="M8 3v10" />
    </svg>
  )
}

function SplitDownIcon(): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width={12}
      height={12}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      aria-hidden
    >
      <rect x={2.5} y={3} width={11} height={10} rx={1.4} />
      <path d="M2.5 8h11" />
    </svg>
  )
}

export function WorkbenchTerminalSplitMenu(props: {
  shown: boolean
  splitRowActive: boolean
  splitRowRef: RefObject<HTMLDivElement | null>
  splitRightShortcutLabel: string
  splitDownShortcutLabel: string
}): JSX.Element {
  return (
    <div
      className={cn(
        'absolute left-[110px] top-[78px] z-10 min-w-[218px] origin-top-left rounded-lg border border-border bg-card p-1.5 font-sans text-[12px] text-foreground shadow-[0_16px_38px_rgba(24,24,27,0.18),0_2px_6px_rgba(24,24,27,0.08)] transition-[opacity,transform] duration-[160ms] ease-out',
        props.shown ? 'opacity-100' : '-translate-y-[3px] scale-[0.985] opacity-0'
      )}
      style={{ pointerEvents: 'none' }}
    >
      <MenuSkeleton width={70} />
      <MenuSkeleton width={56} />
      <MenuSeparator />
      <div
        ref={props.splitRowRef}
        className={cn(
          'grid h-[22px] grid-cols-[18px_1fr_auto] items-center gap-2 rounded-[5px] px-1.5 py-1 pl-1.5',
          props.splitRowActive
            ? 'bg-foreground/[0.07] shadow-[inset_0_0_0_1px_rgba(24,24,27,0.06)]'
            : null
        )}
      >
        <span className="inline-flex items-center justify-center text-muted-foreground">
          <SplitRightIcon />
        </span>
        <span className="whitespace-nowrap leading-none">
          {translate(
            'auto.components.feature.wall.WorkbenchAnimatedVisual.e370fa8c2b',
            'Split Terminal Right'
          )}
        </span>
        <span className="font-mono text-[11px] text-muted-foreground">
          {props.splitRightShortcutLabel}
        </span>
      </div>
      <div className="grid h-[22px] grid-cols-[18px_1fr_auto] items-center gap-2 rounded-[5px] px-1.5 py-1 pl-1.5">
        <span className="inline-flex items-center justify-center text-muted-foreground">
          <SplitDownIcon />
        </span>
        <span className="whitespace-nowrap leading-none">
          {translate(
            'auto.components.feature.wall.WorkbenchAnimatedVisual.ca2cfbf188',
            'Split Terminal Down'
          )}
        </span>
        <span className="font-mono text-[11px] text-muted-foreground">
          {props.splitDownShortcutLabel}
        </span>
      </div>
      <MenuSeparator />
      <MenuSkeleton width={64} />
      <MenuSkeleton width={48} />
    </div>
  )
}

function MenuSkeleton(props: { width: number }): JSX.Element {
  return (
    <div className="flex h-[18px] items-center px-2.5">
      <span
        className="block h-1.5 rounded-[3px] bg-foreground/[0.16]"
        style={{ width: `${props.width}%` }}
      />
    </div>
  )
}

function MenuSeparator(): JSX.Element {
  return <div className="my-1 h-px bg-foreground/[0.08]" />
}
