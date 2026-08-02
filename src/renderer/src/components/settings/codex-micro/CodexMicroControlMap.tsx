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
  { control: 'AG00', x: 79, y: 25, width: 36, height: 36 },
  { control: 'AG01', x: 123, y: 25, width: 36, height: 36 },
  { control: 'AG02', x: 22, y: 70, width: 36, height: 36 },
  { control: 'AG03', x: 66, y: 70, width: 36, height: 36 },
  { control: 'AG04', x: 110, y: 70, width: 36, height: 36 },
  { control: 'AG05', x: 154, y: 70, width: 36, height: 36 },
  { control: 'ACT06', x: 22, y: 112, width: 36, height: 36 },
  { control: 'ACT07', x: 66, y: 112, width: 36, height: 36 },
  { control: 'ACT08', x: 110, y: 112, width: 36, height: 36 },
  { control: 'ACT09', x: 154, y: 112, width: 36, height: 36 },
  { control: 'ACT10', x: 66, y: 154, width: 80, height: 36 },
  { control: 'ACT12', x: 154, y: 154, width: 36, height: 36 }
]

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
  ACT10: ['auto.components.settings.codexMicro.controlACT10', 'Microphone key'],
  ACT11: ['auto.components.settings.codexMicro.controlACT11', 'Microphone key · paired signal'],
  ACT12: ['auto.components.settings.codexMicro.controlACT12', 'Small right key'],
  ENC_CC: ['auto.components.settings.codexMicro.controlEncCc', 'Dial · clockwise'],
  ENC_CW: ['auto.components.settings.codexMicro.controlEncCw', 'Dial · counterclockwise'],
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
      viewBox="0 0 232 208"
      role="group"
      aria-label={translate(
        'auto.components.settings.codexMicro.controlMap',
        'Codex Micro control map'
      )}
      className="mx-auto h-auto w-full max-w-sm"
    >
      <rect x="4" y="4" width="224" height="200" rx="18" className="fill-muted/30 stroke-border" />
      <path d="M116 11v8m-4-4 4-4 4 4" className="fill-none stroke-muted-foreground" />

      <circle cx="40" cy="43" r="20" className="fill-card stroke-border" />
      <DialRotationControl
        control="ENC_CW"
        path="M40 23A20 20 0 0 0 40 63L40 54A11 11 0 0 1 40 32Z"
        labelX={30}
        label="↶"
        active={activeControl === 'ENC_CW'}
        onActivate={onActivate}
        onHover={onHover}
      />
      <DialRotationControl
        control="ENC_CC"
        path="M40 23A20 20 0 0 1 40 63L40 54A11 11 0 0 0 40 32Z"
        labelX={50}
        label="↷"
        active={activeControl === 'ENC_CC'}
        onActivate={onActivate}
        onHover={onHover}
      />
      <SvgControl
        control="ENC_CLK"
        active={activeControl === 'ENC_CLK'}
        onActivate={onActivate}
        onHover={onHover}
      >
        <circle cx="40" cy="43" r="10.5" className="control-surface fill-card stroke-border" />
        <line
          x1="35"
          y1="43"
          x2="45"
          y2="43"
          className="stroke-muted-foreground stroke-[1.3] [stroke-linecap:round]"
        />
      </SvgControl>

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
        <circle cx="190" cy="43" r="15" className="fill-card stroke-border" />
        <path
          d="M190 32v6m0 10v6m-11-11h6m10 0h6m-14-4 3-3 3 3m-6 8 3 3 3-3"
          className="fill-none stroke-muted-foreground"
        />
      </g>

      <g
        role="img"
        aria-label={translate('auto.components.settings.codexMicro.touchSensor', 'Touch sensor')}
      >
        <circle cx="40" cy="172" r="12" className="fill-card stroke-border" />
        <circle cx="40" cy="172" r="4" className="fill-muted-foreground" />
      </g>
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

function DialRotationControl({
  control,
  path,
  labelX,
  label,
  active,
  onActivate,
  onHover
}: Omit<Props, 'activeControl'> & {
  control: CodexMicroControlId
  path: string
  labelX: number
  label: string
  active: boolean
}): React.JSX.Element {
  return (
    <SvgControl control={control} active={active} onActivate={onActivate} onHover={onHover}>
      <path d={path} className="control-surface fill-muted/40 stroke-border" />
      <text
        x={labelX}
        y="46"
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
        active
          ? '[&>.control-surface]:fill-accent [&>.control-surface]:stroke-ring [&>.control-surface]:stroke-2 [&>line]:stroke-accent-foreground [&>text]:fill-accent-foreground'
          : ''
      }`}
    >
      <title>{codexMicroControlLabel(control)}</title>
      {children}
    </g>
  )
}
