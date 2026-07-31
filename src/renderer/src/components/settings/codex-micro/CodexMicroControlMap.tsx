import type { KeyboardEvent } from 'react'
import type { CodexMicroControlId } from '../../../../../shared/codex-micro-types'
import { translate } from '@/i18n/i18n'

type Props = {
  activeControl: CodexMicroControlId | null
  onActivate: (control: CodexMicroControlId) => void
  onHover: (control: CodexMicroControlId | null) => void
}

type KeyShape = {
  control: CodexMicroControlId
  x: number
  y: number
  width: number
  height: number
}

const KEY_SHAPES: KeyShape[] = [
  { control: 'AG00', x: 78, y: 30, width: 34, height: 34 },
  { control: 'AG01', x: 120, y: 30, width: 34, height: 34 },
  { control: 'AG02', x: 20, y: 76, width: 34, height: 34 },
  { control: 'AG03', x: 62, y: 76, width: 34, height: 34 },
  { control: 'AG04', x: 104, y: 76, width: 34, height: 34 },
  { control: 'AG05', x: 146, y: 76, width: 34, height: 34 },
  { control: 'ACT06', x: 20, y: 118, width: 34, height: 34 },
  { control: 'ACT07', x: 62, y: 118, width: 34, height: 34 },
  { control: 'ACT08', x: 104, y: 118, width: 34, height: 34 },
  { control: 'ACT09', x: 146, y: 118, width: 34, height: 34 },
  { control: 'ACT11', x: 62, y: 160, width: 76, height: 34 },
  { control: 'ACT12', x: 146, y: 160, width: 34, height: 34 }
]

const TOUCH_CONTROL: CodexMicroControlId = 'ACT10'

const CONTROL_LABELS: Record<CodexMicroControlId, readonly [string, string]> = {
  AG00: ['auto.components.settings.codexMicro.controlAG00', 'Top-left agent key'],
  AG01: ['auto.components.settings.codexMicro.controlAG01', 'Top-right agent key'],
  AG02: ['auto.components.settings.codexMicro.controlAG02', 'Middle-left agent key'],
  AG03: ['auto.components.settings.codexMicro.controlAG03', 'Middle-center-left agent key'],
  AG04: ['auto.components.settings.codexMicro.controlAG04', 'Middle-center-right agent key'],
  AG05: ['auto.components.settings.codexMicro.controlAG05', 'Middle-right agent key'],
  ACT06: ['auto.components.settings.codexMicro.controlACT06', 'Lower-left command key'],
  ACT07: ['auto.components.settings.codexMicro.controlACT07', 'Lower-center-left command key'],
  ACT08: ['auto.components.settings.codexMicro.controlACT08', 'Lower-center-right command key'],
  ACT09: ['auto.components.settings.codexMicro.controlACT09', 'Lower-right command key'],
  ACT10: ['auto.components.settings.codexMicro.controlACT10', 'Touch control'],
  ACT11: ['auto.components.settings.codexMicro.controlACT11', 'Wide command key'],
  ACT12: ['auto.components.settings.codexMicro.controlACT12', 'Bottom-right command key'],
  ENC_CC: ['auto.components.settings.codexMicro.controlEncCc', 'Dial · counterclockwise'],
  ENC_CW: ['auto.components.settings.codexMicro.controlEncCw', 'Dial · clockwise'],
  ENC_CLK: ['auto.components.settings.codexMicro.controlEncClk', 'Dial · press']
}

export function codexMicroControlLabel(control: CodexMicroControlId): string {
  const [key, fallback] = CONTROL_LABELS[control]
  return translate(key, fallback)
}

export function CodexMicroControlMap({
  activeControl,
  onActivate,
  onHover
}: Props): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 200 216"
      role="group"
      aria-label={translate(
        'auto.components.settings.codexMicro.controlMap',
        'Codex Micro control map'
      )}
      className="mx-auto h-auto w-full max-w-sm"
    >
      <rect x="4" y="4" width="192" height="208" rx="18" className="fill-muted/30 stroke-border" />
      <path d="M100 14v8m-4-4 4-4 4 4" className="fill-none stroke-muted-foreground" />

      <circle cx="42" cy="47" r="27" className="fill-card stroke-border" />
      <DialControl
        control="ENC_CC"
        x={28}
        label="↶"
        active={activeControl === 'ENC_CC'}
        onActivate={onActivate}
        onHover={onHover}
      />
      <DialControl
        control="ENC_CLK"
        x={42}
        label="•"
        active={activeControl === 'ENC_CLK'}
        onActivate={onActivate}
        onHover={onHover}
      />
      <DialControl
        control="ENC_CW"
        x={56}
        label="↷"
        active={activeControl === 'ENC_CW'}
        onActivate={onActivate}
        onHover={onHover}
      />

      {KEY_SHAPES.map((shape) => (
        <KeyControl
          key={shape.control}
          {...shape}
          active={activeControl === shape.control}
          onActivate={onActivate}
          onHover={onHover}
        />
      ))}

      <g
        role="img"
        aria-label={translate(
          'auto.components.settings.codexMicro.joystickDirections',
          'Joystick directions'
        )}
      >
        <circle cx="167" cy="47" r="20" className="fill-card stroke-border" />
        <path
          d="M167 32v8m0 14v8m-15-15h8m14 0h8m-18-4 3-3 3 3m-6 8 3 3 3-3"
          className="fill-none stroke-muted-foreground"
        />
      </g>

      <SvgControl
        control={TOUCH_CONTROL}
        active={activeControl === TOUCH_CONTROL}
        onActivate={onActivate}
        onHover={onHover}
      >
        <circle cx="37" cy="177" r="13" className="control-surface fill-card stroke-border" />
        <circle cx="37" cy="177" r="4" className="fill-muted-foreground" />
        <text
          x="37"
          y="199"
          textAnchor="middle"
          className="pointer-events-none fill-muted-foreground text-[6px]"
        >
          {TOUCH_CONTROL}
        </text>
      </SvgControl>
    </svg>
  )
}

function KeyControl({
  control,
  x,
  y,
  width,
  height,
  active,
  onActivate,
  onHover
}: KeyShape & Omit<Props, 'activeControl'> & { active: boolean }): React.JSX.Element {
  return (
    <SvgControl control={control} active={active} onActivate={onActivate} onHover={onHover}>
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        rx="7"
        className="control-surface fill-card stroke-border"
      />
      <text
        x={x + width / 2}
        y={y + height / 2 + 2}
        textAnchor="middle"
        className="pointer-events-none fill-muted-foreground text-[6px]"
      >
        {control}
      </text>
    </SvgControl>
  )
}

function DialControl({
  control,
  x,
  label,
  active,
  onActivate,
  onHover
}: Omit<Props, 'activeControl'> & {
  control: CodexMicroControlId
  x: number
  label: string
  active: boolean
}): React.JSX.Element {
  return (
    <SvgControl control={control} active={active} onActivate={onActivate} onHover={onHover}>
      <circle cx={x} cy="47" r="7" className="control-surface fill-card stroke-border" />
      <text
        x={x}
        y="49"
        textAnchor="middle"
        className="pointer-events-none fill-muted-foreground text-[8px]"
      >
        {label}
      </text>
    </SvgControl>
  )
}

function SvgControl({
  control,
  active,
  onActivate,
  onHover,
  children
}: Omit<Props, 'activeControl'> & {
  control: CodexMicroControlId
  active: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const activateFromKeyboard = (event: KeyboardEvent<SVGGElement>): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onActivate(control)
    }
  }

  return (
    <g
      role="button"
      tabIndex={0}
      aria-label={codexMicroControlLabel(control)}
      data-control-id={control}
      data-active={active}
      onClick={() => onActivate(control)}
      onKeyDown={activateFromKeyboard}
      onMouseEnter={() => onHover(control)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(control)}
      onBlur={() => onHover(null)}
      className={`cursor-pointer outline-none [&>*]:transition-colors focus:[&>.control-surface]:stroke-ring focus:[&>.control-surface]:stroke-2 ${
        active ? '[&>.control-surface]:fill-accent [&>.control-surface]:stroke-ring' : ''
      }`}
    >
      <title>{codexMicroControlLabel(control)}</title>
      {children}
    </g>
  )
}
