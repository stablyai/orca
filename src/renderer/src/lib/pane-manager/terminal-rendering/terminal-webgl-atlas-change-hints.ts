import type { ManagedPaneInternal } from '../pane-manager-types'
import {
  verifyPaneWebglAtlasIntegrity,
  type AtlasIntegrityDeps
} from './terminal-webgl-atlas-integrity'

type PublishingAddon = NonNullable<ManagedPaneInternal['webglAddon']>
const pendingHints = new WeakMap<ManagedPaneInternal, WeakSet<PublishingAddon>>()

/** xterm emits before assigning the atlas, so check the latest atlas in the next task. */
export function requestAtlasChangeIntegrityCheck(
  pane: ManagedPaneInternal,
  origin: PublishingAddon,
  deps?: AtlasIntegrityDeps
): void {
  let pending = pendingHints.get(pane)
  if (!pending) {
    pending = new WeakSet()
    pendingHints.set(pane, pending)
  }
  if (pending.has(origin)) {
    return
  }
  pending.add(origin)
  const schedule = deps?.setTimer ?? setTimeout
  try {
    schedule(() => {
      pending.delete(origin)
      if (pane.webglAddon === origin) {
        verifyPaneWebglAtlasIntegrity(pane, 'atlas-change', deps)
      }
    }, 0)
  } catch {
    pending.delete(origin)
  }
}
