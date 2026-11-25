// The area a pointer may cross from a side-panel row to its hover card, which opens beside the panel with
// a gap between them: the convex hull of the point where the pointer left the row and the card's box.
export type Point = { x: number; y: number }

/** The pointer's exit point is padded this much so a pointer leaving along the row's edge still counts. */
const EXIT_PAD = 4

const cross = (o: Point, a: Point, b: Point): number =>
  (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)

/** Andrew's monotone chain: the hull's points counter-clockwise (in screen space, y down). */
function convexHull(points: Point[]): Point[] {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y)
  const half = (list: Point[]): Point[] => {
    const hull: Point[] = []
    for (const point of list) {
      while (hull.length >= 2 && cross(hull.at(-2)!, hull.at(-1)!, point) <= 0) {
        hull.pop()
      }
      hull.push(point)
    }
    hull.pop()
    return hull
  }
  return [...half(sorted), ...half(sorted.toReversed())]
}

/** True when `pointer` is between `exit` (where it left the row) and `card`, or on the card. */
export function inRowCardGraceArea(
  pointer: Point,
  exit: Point,
  card: Pick<DOMRect, 'left' | 'top' | 'right' | 'bottom'>
): boolean {
  const hull = convexHull([
    { x: exit.x - EXIT_PAD, y: exit.y - EXIT_PAD },
    { x: exit.x + EXIT_PAD, y: exit.y - EXIT_PAD },
    { x: exit.x + EXIT_PAD, y: exit.y + EXIT_PAD },
    { x: exit.x - EXIT_PAD, y: exit.y + EXIT_PAD },
    { x: card.left, y: card.top },
    { x: card.right, y: card.top },
    { x: card.right, y: card.bottom },
    { x: card.left, y: card.bottom }
  ])
  // Inside a convex polygon: on the same side of every edge.
  return hull.every((point, index) => cross(point, hull[(index + 1) % hull.length], pointer) >= 0)
}
