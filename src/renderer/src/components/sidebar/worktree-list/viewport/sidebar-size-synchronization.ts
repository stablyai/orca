import type { Virtualizer } from '@tanstack/react-virtual'
import type { SidebarGeometry } from '../listing/sidebar-geometry-slots'

export function synchronizeSidebarSizes(
  model: SidebarGeometry,
  boundaries: readonly number[],
  synchronized: Map<string, number>,
  virtualizer: Pick<Virtualizer<HTMLDivElement, HTMLDivElement>, 'resizeItem'>
): boolean {
  let resized = false
  for (const [index, slot] of model.slots.entries()) {
    const size = boundaries[index + 1]! - boundaries[index]!
    if (synchronized.get(slot.key) !== size) {
      virtualizer.resizeItem(index, size)
      synchronized.set(slot.key, size)
      resized = true
    }
  }
  const keys = new Set(model.slots.map((slot) => slot.key))
  for (const key of synchronized.keys()) {
    if (!keys.has(key)) {
      synchronized.delete(key)
    }
  }
  return resized
}
