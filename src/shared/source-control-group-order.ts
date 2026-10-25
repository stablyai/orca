import type { SourceControlGroupOrder } from './ui-chrome-types'

export const DEFAULT_SOURCE_CONTROL_GROUP_ORDER = 'changes-first' satisfies SourceControlGroupOrder

export function normalizeSourceControlGroupOrder(
  value: unknown
): Exclude<SourceControlGroupOrder, 'untracked-first'> {
  return value === 'changes-first' || value === 'staged-first'
    ? value
    : DEFAULT_SOURCE_CONTROL_GROUP_ORDER
}
