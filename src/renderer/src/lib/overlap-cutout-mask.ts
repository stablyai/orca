import type React from 'react'

type Circle = { x: number; y: number; size: number }

/** Cuts a clear gap where later circles overlap this one, so the gap shows whatever is behind it. */
export function overlapCutoutMask(
  self: Pick<Circle, 'x' | 'y'>,
  above: readonly Circle[],
  gap: number
): Pick<React.CSSProperties, 'maskImage' | 'maskComposite'> {
  const cuts = above.map((other) => {
    const r = other.size / 2 + gap
    const cx = other.x + other.size / 2 - self.x
    const cy = other.y + other.size / 2 - self.y
    return `radial-gradient(circle at ${cx}px ${cy}px, transparent ${r}px, #000 ${r + 0.5}px)`
  })
  return {
    maskImage: cuts.length > 0 ? cuts.join(', ') : undefined,
    maskComposite: cuts.length > 1 ? 'intersect' : undefined
  }
}
