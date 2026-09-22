import { Slider } from '../ui/slider'
import { Label } from '../ui/label'

type ScrollSpeedSliderProps = {
  label: string
  description: string
  value: number
  min: number
  max: number
  step: number
  suffix: string
  onChange: (value: number) => void
}

function formatScrollSpeedValue(value: number): string {
  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
}

export function ScrollSpeedSlider({
  label,
  description,
  value,
  min,
  max,
  step,
  suffix,
  onChange
}: ScrollSpeedSliderProps): React.JSX.Element {
  return (
    <div className="rounded-md border border-border/60 bg-background/50 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <Label className="text-xs font-medium">{label}</Label>
          <p className="text-[11px] leading-4 text-muted-foreground">{description}</p>
        </div>
        <span className="shrink-0 rounded-md border border-border/50 bg-muted/40 px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-foreground">
          {formatScrollSpeedValue(value)}
          {suffix}
        </span>
      </div>
      <Slider
        className="mt-3"
        min={min}
        max={max}
        step={step}
        value={[value]}
        onValueChange={([next]) => {
          if (next !== undefined) {
            onChange(next)
          }
        }}
      />
      <div className="mt-1 flex justify-between font-mono text-[10px] text-muted-foreground">
        <span>{formatScrollSpeedValue(min)}</span>
        <span>{formatScrollSpeedValue(max)}</span>
      </div>
    </div>
  )
}
