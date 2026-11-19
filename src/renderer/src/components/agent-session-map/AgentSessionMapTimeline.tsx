import type { AgentMapTimelineEvent } from '../../../../shared/agent-session-map/agent-session-map-model'
import { translate } from '@/i18n/i18n'

/** The time scrubber: drag to replay the session up to a moment; the far right is the
 *  live edge (follow). Scrubbing is indexed over the timeline so the thumb lands on
 *  real events; the last stop is "live". */
export function AgentSessionMapTimeline({
  timeline,
  playheadTs,
  onScrub
}: {
  timeline: AgentMapTimelineEvent[]
  /** null = live edge (follow the newest event). */
  playheadTs: number | null
  onScrub: (ts: number | null) => void
}) {
  const liveLabel = translate('components.agentSessionMap.timeline.live', 'Live')
  const scrubberAriaLabel = translate(
    'components.agentSessionMap.timeline.scrubberAriaLabel',
    'Session time scrubber'
  )
  const lastIndex = timeline.length - 1
  const isLive = playheadTs === null
  const cursor = isLive ? (timeline[lastIndex]?.ts ?? 0) : playheadTs

  const value = lastIndex < 0 ? 0 : isLive ? lastIndex : nearestIndexAtOrBefore(timeline, cursor)

  const handleInput = (raw: number): void => {
    if (lastIndex < 0) {
      return
    }
    if (raw >= lastIndex) {
      onScrub(null)
      return
    }
    onScrub(timeline[raw]?.ts ?? null)
  }

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={() => onScrub(null)}
        className={`rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
          isLive
            ? 'bg-primary text-primary-foreground'
            : 'bg-muted text-muted-foreground hover:text-foreground'
        }`}
        aria-pressed={isLive}
      >
        {isLive ? `● ${liveLabel}` : liveLabel}
      </button>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        {lastIndex > 0 && (
          <div className="relative h-1" aria-hidden>
            {timeline.map((event, i) => (
              <span
                key={i}
                className={`absolute top-0 h-full w-px ${markerClass(event)}`}
                style={{ left: `${(i / lastIndex) * 100}%` }}
              />
            ))}
          </div>
        )}
        <input
          type="range"
          min={0}
          max={Math.max(0, lastIndex)}
          step={1}
          value={value}
          onChange={(event) => handleInput(Number(event.target.value))}
          disabled={lastIndex < 0}
          className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted disabled:cursor-default"
          aria-label={scrubberAriaLabel}
        />
      </div>
      <span className="w-16 text-right text-xs tabular-nums text-muted-foreground">
        {lastIndex < 0 ? '—' : `${value + 1}/${lastIndex + 1}`}
      </span>
    </div>
  )
}

/** Ticks mark the moments worth scrubbing to: prompts, spawns, questions, failures. */
function markerClass(event: AgentMapTimelineEvent): string {
  if (event.failed) {
    return 'bg-destructive'
  }
  if (event.kind === 'prompt' || event.kind === 'agent-spawn') {
    return 'bg-primary'
  }
  if (event.kind === 'question' || event.kind === 'approval') {
    return 'bg-amber-500'
  }
  return 'bg-muted-foreground/40'
}

function nearestIndexAtOrBefore(timeline: AgentMapTimelineEvent[], ts: number): number {
  let index = 0
  for (let i = 0; i < timeline.length; i++) {
    if (timeline[i]?.ts <= ts) {
      index = i
    } else {
      break
    }
  }
  return index
}
