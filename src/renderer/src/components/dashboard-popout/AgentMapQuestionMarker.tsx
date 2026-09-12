import React from 'react'
import { AgentQuestionIcon } from '@/components/AgentQuestionIcon'

// Why: hue alone can't carry 'waiting' on the map — it sits one step from
// blocked-red, and nodes shrink as you zoom out. The badge repeats the same
// question glyph every other surface uses, so the state is readable by shape.

/** Question badge marking an agent that is waiting on the user. */
export function AgentMapQuestionMarker({
  radius,
  markerScale
}: {
  radius: number
  markerScale: number
}): React.JSX.Element {
  const iconSize = radius * 0.74 * markerScale
  // Mirrors the unread dot across the node so the two never stack.
  const offset = radius * Math.SQRT1_2
  return (
    <g transform={`translate(${offset} ${-offset})`} aria-hidden="true">
      {/* Cuts the node ring out from behind the glyph. */}
      <circle
        className="agent-map-agent-question-backdrop"
        data-agent-question-marker=""
        r={iconSize * 0.62}
        vectorEffect="none"
      />
      <AgentQuestionIcon
        className="agent-map-agent-question-icon"
        x={-iconSize / 2}
        y={-iconSize / 2}
        width={iconSize}
        height={iconSize}
      />
    </g>
  )
}
