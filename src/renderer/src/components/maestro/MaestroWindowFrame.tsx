import type { ReactNode } from 'react'
import { MAESTRO_STATE_COLOR, type MaestroStateTone } from './maestro-window-model'
import type { MaestroAnnotationTone } from './maestro-annotation-tone'

type WindowRootProps = {
  selected: boolean
  reducedMotion: boolean
  tone?: MaestroAnnotationTone
  className?: string
}

/** Root attributes every window shares; each card keeps its own element and role. */
export function maestroWindowRootProps({
  selected,
  reducedMotion,
  tone = 'observation',
  className = ''
}: WindowRootProps) {
  return {
    className: `maestro-window ${className}`.trim(),
    'data-selected': selected ? 'true' : 'false',
    'data-motion': reducedMotion ? 'static' : 'animated',
    'data-maestro-tone': tone
  } as const
}

export function MaestroStatePip({
  tone,
  className = ''
}: {
  tone: MaestroStateTone
  className?: string
}): React.JSX.Element {
  return (
    <span
      className={`size-1.5 shrink-0 rounded-full ${className}`}
      style={{ background: MAESTRO_STATE_COLOR[tone] }}
      aria-hidden
    />
  )
}

/** The pip carries the state colour, so the word is confirmation rather than the signal. */
export function MaestroStatusPill({
  label,
  tone,
  onDark = false
}: {
  label: string
  tone: MaestroStateTone
  onDark?: boolean
}): React.JSX.Element {
  return (
    <span
      className={`flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-px text-[10px] font-medium leading-4 ${
        onDark
          ? 'border-white/15 bg-white/10 text-[color:var(--maestro-screen-fg)]'
          : 'border-border bg-background text-muted-foreground'
      }`}
      title={label}
    >
      <MaestroStatePip tone={tone} />
      <span className="max-w-24 truncate">{label}</span>
    </span>
  )
}

export function MaestroWindowChrome({
  icon,
  title,
  trailing
}: {
  icon: ReactNode
  title: string
  trailing?: ReactNode
}): React.JSX.Element {
  return (
    <span className="maestro-window-chrome">
      <span
        className="flex size-4 shrink-0 items-center justify-center text-muted-foreground"
        style={{ color: 'var(--maestro-tone)' }}
        aria-hidden
      >
        {icon}
      </span>
      <span
        className="min-w-0 flex-1 truncate text-[12px] font-medium leading-4 tracking-[-0.01em] text-foreground"
        title={title}
      >
        {title}
      </span>
      {trailing}
    </span>
  )
}

/** Type lives here so the chrome strip is free for identity; neither line repeats the other. */
export function MaestroWindowFoot({
  typeLabel,
  detail,
  icon
}: {
  typeLabel: string
  detail?: string
  icon?: ReactNode
}): React.JSX.Element {
  return (
    <span className="maestro-window-foot" title={detail ? `${typeLabel} · ${detail}` : typeLabel}>
      {icon ? (
        <span className="flex size-3 shrink-0 items-center justify-center" aria-hidden>
          {icon}
        </span>
      ) : null}
      <span className="shrink-0 text-[10px] font-semibold uppercase leading-4 tracking-[0.05em]">
        {typeLabel}
      </span>
      {detail ? (
        <>
          <span className="h-2.5 w-px shrink-0 bg-border" aria-hidden />
          <span className="min-w-0 flex-1 truncate font-mono text-[10px] leading-4">{detail}</span>
        </>
      ) : null}
    </span>
  )
}
