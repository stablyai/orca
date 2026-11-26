import { normalizeExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import {
  isSidebarHeaderActionTarget,
  readOrderedHeaderRects,
  type OrderedHeaderRect
} from './ordered-header-drag-dom'

export type HostHeaderRect = OrderedHeaderRect

export const isHostHeaderActionTarget = isSidebarHeaderActionTarget

export function readHostHeaderRects(container: HTMLElement): HostHeaderRect[] {
  return readOrderedHeaderRects(container, '[data-host-header-drag-id]', (header) =>
    normalizeExecutionHostId(header.dataset.hostHeaderDragId)
  )
}
