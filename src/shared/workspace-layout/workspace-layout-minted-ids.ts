// Ids the Loader invents for what stored data lacks or repeats, derived from what each stands in
// for: reloading the same data, or data that changed elsewhere, mints the same ids, so a view
// never remounts a pane, tab or group nothing touched.

import type { WorkspaceLayoutLoadContext } from './workspace-layout-load-types'

/** FNV-1a over the name, four lanes with different offsets: 128 stable bits, not a secret. */
function nameBits(name: string): number[] {
  const lanes = [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b]
  return lanes.map((offset, lane) => {
    let hash = offset ^ lane
    for (let index = 0; index < name.length; index += 1) {
      hash = Math.imul(hash ^ name.charCodeAt(index), 0x01000193)
    }
    return hash >>> 0
  })
}

/** A UUID (version 5 layout, so pane-key checks accept it) that depends only on `name`. */
export function nameBasedUuid(name: string): string {
  const hex = nameBits(name)
    .map((word) => word.toString(16).padStart(8, '0'))
    .join('')
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

export function nameBasedLoadContext(): WorkspaceLayoutLoadContext {
  return { mintId: nameBasedUuid, mintLeafId: nameBasedUuid }
}
