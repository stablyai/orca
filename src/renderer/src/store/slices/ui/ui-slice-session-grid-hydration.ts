import type { PersistedUIState } from '../../../../../shared/persisted-ui-state-types'
import {
  normalizeSessionGridPreset,
  normalizeSessionGridScrollMode,
  normalizeSessionGridStateFilter,
  normalizeSessionGridWheelTarget
} from '../../../../../shared/session-grid-types'
import { sanitizeSessionGridHiddenTabIds } from '../session-grid-hidden-tabs'
import { sanitizeSessionGridTabOrder } from '../session-grid-tab-order'
import { clampSessionGridZoom } from '../session-grid-zoom'
import type { UISlice } from './ui-slice-contract'
import { preserveStringArrayIdentity } from './ui-slice-hydration-sanitizers'

type SessionGridHydratedState = Pick<
  UISlice,
  | 'sessionsGridPreset'
  | 'sessionsGridZoom'
  | 'sessionsGridShowEmpty'
  | 'sessionsGridFilter'
  | 'sessionsGridStateFilter'
  | 'sessionsGridScrollMode'
  | 'sessionsGridWheelTarget'
  | 'sessionsGridTabOrder'
  | 'sessionsGridHiddenTabIds'
>

/**
 * Session grid layout off the wire or disk. Validated field by field — a
 * hand-edited profile, a downgrade or a newer paired client can carry a preset
 * the layout switch has no case for — and the order array keeps its identity
 * when unchanged, or every broadcast would recompute and re-render the grid.
 */
export function hydrateSessionGridState(
  ui: Partial<PersistedUIState>,
  current: SessionGridHydratedState
): SessionGridHydratedState {
  const tabOrder = Array.isArray(ui.sessionsGridTabOrder)
    ? sanitizeSessionGridTabOrder(ui.sessionsGridTabOrder)
    : current.sessionsGridTabOrder
  const hiddenTabIds = Array.isArray(ui.sessionsGridHiddenTabIds)
    ? sanitizeSessionGridHiddenTabIds(ui.sessionsGridHiddenTabIds)
    : current.sessionsGridHiddenTabIds
  return {
    sessionsGridPreset:
      normalizeSessionGridPreset(ui.sessionsGridPreset) ?? current.sessionsGridPreset,
    sessionsGridZoom:
      typeof ui.sessionsGridZoom === 'number' && Number.isFinite(ui.sessionsGridZoom)
        ? clampSessionGridZoom(ui.sessionsGridZoom)
        : current.sessionsGridZoom,
    sessionsGridShowEmpty:
      typeof ui.sessionsGridShowEmpty === 'boolean'
        ? ui.sessionsGridShowEmpty
        : current.sessionsGridShowEmpty,
    sessionsGridFilter:
      typeof ui.sessionsGridFilter === 'string' && ui.sessionsGridFilter.length > 0
        ? ui.sessionsGridFilter
        : current.sessionsGridFilter,
    sessionsGridStateFilter:
      normalizeSessionGridStateFilter(ui.sessionsGridStateFilter) ??
      current.sessionsGridStateFilter,
    sessionsGridScrollMode:
      normalizeSessionGridScrollMode(ui.sessionsGridScrollMode) ?? current.sessionsGridScrollMode,
    sessionsGridWheelTarget:
      normalizeSessionGridWheelTarget(ui.sessionsGridWheelTarget) ??
      current.sessionsGridWheelTarget,
    sessionsGridTabOrder:
      preserveStringArrayIdentity(current.sessionsGridTabOrder, tabOrder) ??
      current.sessionsGridTabOrder,
    sessionsGridHiddenTabIds:
      preserveStringArrayIdentity(current.sessionsGridHiddenTabIds, hiddenTabIds) ??
      current.sessionsGridHiddenTabIds
  }
}
