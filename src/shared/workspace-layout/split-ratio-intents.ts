// A divider's new ratio as an intent: the split it moved, by path from the root ("first.second";
// "" the root), and its ratio. Main applies it to its own tree, so what else that tree holds stays.
// `split` names the split the window meant; main refuses an intent whose path names another one.

import type { TabGroupLayoutNode } from '../tab-types'
import type { TerminalPaneLayoutNode } from '../terminal-tab-types'
import { SPLIT_RATIO_TOLERANCE } from './terminal-pane-tree'

/** A split by its direction and the first pane (or group) on each side. */
export type SplitIdentity = { direction: string; first: string; second: string }

export type SplitRatioIntent = { path: string; ratio: number; split?: SplitIdentity }

type SplitTree =
  | { type: 'leaf'; leafId?: string; groupId?: string }
  | { type: 'split'; direction: string; first: SplitTree; second: SplitTree; ratio?: number }

const segmentsOf = (path: string): string[] => (path.length > 0 ? path.split('.') : [])
const childPath = (path: string, segment: 'first' | 'second'): string =>
  path.length > 0 ? `${path}.${segment}` : segment

function leadingId(node: SplitTree): string {
  return node.type === 'leaf' ? (node.leafId ?? node.groupId ?? '') : leadingId(node.first)
}

function identityOf(split: Extract<SplitTree, { type: 'split' }>): SplitIdentity {
  return {
    direction: split.direction,
    first: leadingId(split.first),
    second: leadingId(split.second)
  }
}

/** An older window's intent names no split; it is taken at its path. */
function isSplitMeant(node: Extract<SplitTree, { type: 'split' }>, meant?: SplitIdentity): boolean {
  if (!meant) {
    return true
  }
  const actual = identityOf(node)
  return (
    actual.direction === meant.direction &&
    actual.first === meant.first &&
    actual.second === meant.second
  )
}

/** The splits whose ratio `after` changed from `before`, two trees of one shape. */
export function changedSplitRatios(
  before: SplitTree,
  after: SplitTree,
  path = ''
): SplitRatioIntent[] {
  if (before.type !== 'split' || after.type !== 'split') {
    return []
  }
  const ratio = after.ratio ?? 0.5
  return [
    ...((before.ratio ?? 0.5) !== ratio ? [{ path, ratio, split: identityOf(after) }] : []),
    ...changedSplitRatios(before.first, after.first, childPath(path, 'first')),
    ...changedSplitRatios(before.second, after.second, childPath(path, 'second'))
  ]
}

/** Each split's ratio, as intents. */
export function allSplitRatios(root: SplitTree, path = ''): SplitRatioIntent[] {
  if (root.type !== 'split') {
    return []
  }
  return [
    { path, ratio: root.ratio ?? 0.5, split: identityOf(root) },
    ...allSplitRatios(root.first, childPath(path, 'first')),
    ...allSplitRatios(root.second, childPath(path, 'second'))
  ]
}

/** The split at `path`, as an intent to set its ratio; null when no split is there. */
export function splitRatioIntentAt(
  root: SplitTree,
  path: string,
  ratio: number
): SplitRatioIntent | null {
  let node: SplitTree = root
  for (const segment of segmentsOf(path)) {
    if (node.type !== 'split' || (segment !== 'first' && segment !== 'second')) {
      return null
    }
    node = node[segment]
  }
  return node.type === 'split' ? { path, ratio, split: identityOf(node) } : null
}

/** A ratio this close to even is saved as none, as the window saves it. */
const savedRatio = (ratio: number): { ratio?: number } =>
  Math.abs(ratio - 0.5) > SPLIT_RATIO_TOLERANCE ? { ratio } : {}

function withPaneRatio(
  node: TerminalPaneLayoutNode,
  segments: readonly string[],
  intent: SplitRatioIntent
): TerminalPaneLayoutNode | null {
  if (node.type !== 'split') {
    return null
  }
  const [segment, ...rest] = segments
  if (segment === undefined) {
    if (!isSplitMeant(node, intent.split)) {
      return null
    }
    const { ratio: _previous, ...split } = node
    return { ...split, ...savedRatio(intent.ratio) }
  }
  if (segment !== 'first' && segment !== 'second') {
    return null
  }
  const child = withPaneRatio(node[segment], rest, intent)
  return child && (segment === 'first' ? { ...node, first: child } : { ...node, second: child })
}

function withGroupRatio(
  node: TabGroupLayoutNode,
  segments: readonly string[],
  intent: SplitRatioIntent
): TabGroupLayoutNode | null {
  if (node.type !== 'split') {
    return null
  }
  const [segment, ...rest] = segments
  if (segment === undefined) {
    return isSplitMeant(node, intent.split) ? { ...node, ratio: intent.ratio } : null
  }
  if (segment !== 'first' && segment !== 'second') {
    return null
  }
  const child = withGroupRatio(node[segment], rest, intent)
  return child && (segment === 'first' ? { ...node, first: child } : { ...node, second: child })
}

/** `root` with each intent's split at its ratio; null when one names no split of `root`, or
 *  another split than the one it means. */
export function withPaneSplitRatios(
  root: TerminalPaneLayoutNode,
  ratios: readonly SplitRatioIntent[]
): TerminalPaneLayoutNode | null {
  let next: TerminalPaneLayoutNode | null = root
  for (const intent of ratios) {
    next = next && withPaneRatio(next, segmentsOf(intent.path), intent)
  }
  return next
}

/** As `withPaneSplitRatios`, for a workspace's group splits, whose ratios are saved as set. */
export function withGroupSplitRatios(
  root: TabGroupLayoutNode,
  ratios: readonly SplitRatioIntent[]
): TabGroupLayoutNode | null {
  let next: TabGroupLayoutNode | null = root
  for (const intent of ratios) {
    next = next && withGroupRatio(next, segmentsOf(intent.path), intent)
  }
  return next
}
