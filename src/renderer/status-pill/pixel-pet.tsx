// Why: Vibe Island represents each agent/state with a tiny 8-bit "pet" (pixel
// art creature) rather than a glossy avatar. This mirrors that shape and is
// tinted by the live state color (work / idle / alert / question).

const PET_COLORS: Record<string, string> = {
  working: '#60a5fa',
  idle: '#4ade80',
  done: '#4ade80',
  blocked: '#fbbf24',
  waiting: '#06b6d4'
}

/** A small 8-bit pixel-art creature (two glowing eyes + body), tinted by the
 *  agent state. `color` overrides the state-derived tint when set. */
export function PixelPet({
  state,
  color,
  size = 16
}: {
  state: string
  color?: string
  size?: number
}): React.JSX.Element {
  const fill = color ?? PET_COLORS[state] ?? PET_COLORS.idle
  const eye = 'rgba(255,255,255,0.95)'
  const dark = '#000'
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 13 8"
      shapeRendering="crispEdges"
      style={{ flexShrink: 0, filter: `drop-shadow(0 0 2px ${fill})` }}
      aria-hidden="true"
    >
      {/* eyes (bright) */}
      <rect x="2" y="2" width="1" height="1" fill={eye} />
      <rect x="5" y="2" width="1" height="1" fill={eye} />
      {/* body top row */}
      <rect x="1" y="3" width="6" height="1" fill={fill} />
      <rect x="2" y="3" width="1" height="1" fill={dark} />
      <rect x="5" y="3" width="1" height="1" fill={dark} />
      {/* body mid row */}
      <rect x="1" y="4" width="6" height="1" fill={fill} />
      {/* feet */}
      <rect x="2" y="5" width="2" height="1" fill={fill} />
      <rect x="5" y="5" width="2" height="1" fill={fill} />
    </svg>
  )
}
