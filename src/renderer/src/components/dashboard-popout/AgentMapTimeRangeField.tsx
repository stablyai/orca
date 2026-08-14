import { Slider } from '@/components/ui/slider'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import {
  AGENT_MAP_TIME_MAX_INDEX,
  agentMapTimeStopLabel,
  isFullAgentMapTimeRange,
  type AgentMapTimeRange
} from './agent-map-time-filter'

type AgentMapTimeRangeFieldProps = {
  label: string
  range: AgentMapTimeRange
  onChange: (range: AgentMapTimeRange) => void
}

/** Ticks are sparse on purpose — the scale is non-linear, so labelling every
 *  stop would read as evenly spaced time when it is not. */
const TICKS = [0, 5, 9, 12, AGENT_MAP_TIME_MAX_INDEX]

export function AgentMapTimeRangeField({
  label,
  range,
  onChange
}: AgentMapTimeRangeFieldProps): React.JSX.Element {
  const isFull = isFullAgentMapTimeRange(range)
  return (
    <div className="px-1.5 pt-1 pb-2">
      <div className="flex items-baseline gap-2 text-xs">
        <span>{label}</span>
        <span
          className={cn(
            'ml-auto text-[11px] tabular-nums',
            isFull ? 'text-muted-foreground' : 'text-foreground'
          )}
        >
          {isFull
            ? translate('dashboardPopout.map.filters.timeAny', 'any')
            : `${agentMapTimeStopLabel(range.min)} – ${agentMapTimeStopLabel(range.max)}`}
        </span>
      </div>
      <Slider
        className="mt-2"
        aria-label={label}
        min={0}
        max={AGENT_MAP_TIME_MAX_INDEX}
        step={1}
        minStepsBetweenThumbs={0}
        value={[range.min, range.max]}
        thumbLabels={[
          translate('dashboardPopout.map.filters.timeMinimum', '{{label}} minimum', { label }),
          translate('dashboardPopout.map.filters.timeMaximum', '{{label}} maximum', { label })
        ]}
        thumbValueLabels={[agentMapTimeStopLabel(range.min), agentMapTimeStopLabel(range.max)]}
        onValueChange={([min, max]) => onChange({ min, max })}
      />
      <div className="mt-1 flex justify-between text-[9px] text-muted-foreground">
        {TICKS.map((tick) => (
          <span key={tick}>{agentMapTimeStopLabel(tick)}</span>
        ))}
      </div>
    </div>
  )
}
