// Why: pure planner for `orca.yaml layout` → split-tree ops. Kept in a
// separate module so layout-rules.ts stays under the renderer's
// max-lines budget and the planner can be unit-tested in isolation.

import {
  classifyPosition,
  type LayoutConfig,
  type LayoutGroupPosition
} from '../../../shared/orca-yaml-layout'

export type LayoutSeedOp =
  | { kind: 'init'; name: string }
  | {
      kind: 'split'
      sourceName: string
      newName: string
      direction: 'left' | 'right' | 'up' | 'down'
    }

export type LayoutSeedPlan = {
  ops: LayoutSeedOp[]
  initialActiveGroupName: string
}

type Bucket = { name: string; position: LayoutGroupPosition }
type BucketKey =
  | 'leftTop'
  | 'leftBottom'
  | 'left'
  | 'rightTop'
  | 'rightBottom'
  | 'right'
  | 'top'
  | 'bottom'
  | 'center'
type Buckets = Record<BucketKey, Bucket | null>

function classify(position: LayoutGroupPosition): BucketKey {
  const cls = classifyPosition(position)
  if (cls.horizontalSide === 'left') {
    if (cls.verticalSide === 'top') {
      return 'leftTop'
    }
    if (cls.verticalSide === 'bottom') {
      return 'leftBottom'
    }
    return 'left'
  }
  if (cls.horizontalSide === 'right') {
    if (cls.verticalSide === 'top') {
      return 'rightTop'
    }
    if (cls.verticalSide === 'bottom') {
      return 'rightBottom'
    }
    return 'right'
  }
  if (cls.verticalSide === 'top') {
    return 'top'
  }
  if (cls.verticalSide === 'bottom') {
    return 'bottom'
  }
  return 'center'
}

function emptyBuckets(): Buckets {
  return {
    leftTop: null,
    leftBottom: null,
    left: null,
    rightTop: null,
    rightBottom: null,
    right: null,
    top: null,
    bottom: null,
    center: null
  }
}

// Promote single-axis anchors into two-axis slots so the partition
// logic has at most one bucket per visual region. Multiple destination
// candidates per source so e.g. `{a: left, b: top, c: bottom}` doesn't
// silently drop b/c when leftTop/leftBottom are already taken. Each
// orphan side has 2 corner candidates — if both are filled the bucket
// stays orphaned and `warnDroppedOrphans` surfaces the issue.
const PROMOTIONS: [BucketKey, BucketKey][] = [
  ['leftTop', 'left'],
  ['leftBottom', 'left'],
  ['rightTop', 'right'],
  ['rightBottom', 'right'],
  ['leftTop', 'top'],
  ['rightTop', 'top'],
  ['leftBottom', 'bottom'],
  ['rightBottom', 'bottom']
]

function promoteOrphans(buckets: Buckets): void {
  for (const [target, source] of PROMOTIONS) {
    if (!buckets[target] && buckets[source]) {
      buckets[target] = buckets[source]
      buckets[source] = null
    }
  }
}

function bucketize(config: LayoutConfig): Buckets | null {
  const entries = config.groups ? Object.entries(config.groups) : []
  if (entries.length === 0) {
    return null
  }
  const buckets = emptyBuckets()
  for (const [name, def] of entries) {
    const key = classify(def.position)
    const occupant = buckets[key]
    if (occupant) {
      // Why: schema can't catch this — positions are values, not keys.
      // Warn so the user notices instead of silently losing one group.
      // eslint-disable-next-line no-console -- intentional dev warning
      console.warn(
        `[layout-rules] Group "${name}" at position '${def.position}' collides with "${occupant.name}" at the same position; "${occupant.name}" will be replaced. Use a more specific position to disambiguate.`
      )
    }
    buckets[key] = { name, position: def.position }
  }
  promoteOrphans(buckets)
  return buckets
}

function planFromBuckets(buckets: Buckets): LayoutSeedOp[] | null {
  const ops: LayoutSeedOp[] = []
  const init = (b: Bucket): void => {
    ops.push({ kind: 'init', name: b.name })
  }
  const split = (
    sourceName: string,
    next: Bucket,
    direction: 'left' | 'right' | 'up' | 'down'
  ): void => {
    ops.push({ kind: 'split', sourceName, newName: next.name, direction })
  }
  const subSplit = (column: { first: Bucket; top: Bucket | null; bottom: Bucket | null }): void => {
    if (!column.top || !column.bottom) {
      return
    }
    const other = column.first === column.top ? column.bottom : column.top
    split(column.first.name, other, column.first === column.top ? 'down' : 'up')
  }

  const { leftTop: lt, leftBottom: lb, rightTop: rt, rightBottom: rb, center } = buckets
  const hasLeft = !!(lt || lb)
  const hasRight = !!(rt || rb)

  if (hasLeft && hasRight) {
    const leftFirst = lt ?? lb
    const rightFirst = rt ?? rb
    if (!leftFirst || !rightFirst) {
      return null
    }
    init(leftFirst)
    split(leftFirst.name, rightFirst, 'right')
    subSplit({ first: leftFirst, top: lt, bottom: lb })
    subSplit({ first: rightFirst, top: rt, bottom: rb })
  } else if (hasLeft) {
    const first = lt ?? lb
    if (!first) {
      return null
    }
    init(first)
    subSplit({ first, top: lt, bottom: lb })
  } else if (hasRight) {
    const first = rt ?? rb
    if (!first) {
      return null
    }
    init(first)
    subSplit({ first, top: rt, bottom: rb })
  } else if (center) {
    init(center)
  } else {
    return null
  }
  return ops
}

export function planLayoutSeed(config: LayoutConfig): LayoutSeedPlan | null {
  const buckets = bucketize(config)
  if (!buckets) {
    return null
  }
  const ops = planFromBuckets(buckets)
  if (!ops) {
    return null
  }

  // Why: `center` alongside outer-edge groups has no anchor in the
  // split tree. Warn at runtime — schema can't catch this since
  // `center` is a value, not a structural constraint.
  const center = buckets.center
  const hasOuter = !!(buckets.leftTop || buckets.leftBottom || buckets.rightTop || buckets.rightBottom)
  if (center && hasOuter) {
    // eslint-disable-next-line no-console -- intentional dev warning
    console.warn(
      `[layout-rules] Group "${center.name}" with position 'center' was declared alongside outer-edge groups; it has no anchor in the split tree and will be ignored. Either drop \`center\` or declare it as the only group.`
    )
  }

  // Why: if any orphan side bucket survived promotion (because both
  // corner candidates were already filled by explicit corner groups),
  // it has no slot in the split tree. Surface the drop so users
  // notice their layout is over-constrained instead of silently
  // losing groups + breaking rules that point at them.
  for (const side of ['left', 'right', 'top', 'bottom'] as const) {
    const orphan = buckets[side]
    if (orphan) {
      // eslint-disable-next-line no-console -- intentional dev warning
      console.warn(
        `[layout-rules] Group "${orphan.name}" at position '${side}' could not be placed because its corner slots are already taken; it will be ignored. Use an explicit corner position (e.g. left-top, right-bottom) to disambiguate.`
      )
    }
  }

  const rootName = ops[0]?.kind === 'init' ? ops[0].name : null
  if (!rootName) {
    return null
  }
  const terminalRuleTarget = config.rules?.['new-terminal']
  const initialActiveGroupName =
    terminalRuleTarget && config.groups?.[terminalRuleTarget] ? terminalRuleTarget : rootName

  return { ops, initialActiveGroupName }
}
