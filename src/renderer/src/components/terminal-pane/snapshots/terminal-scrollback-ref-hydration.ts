import type { TerminalLayoutSnapshot } from '../../../../../shared/workspace-layout/terminal-tab-types'

export function hydrateTerminalScrollbackRefs(layout: TerminalLayoutSnapshot): {
  layout: TerminalLayoutSnapshot
  hydrated: boolean
} {
  const refs = layout.scrollbackRefsByLeafId
  if (!refs || Object.keys(refs).length === 0) {
    return { layout, hydrated: false }
  }

  const buffers = { ...layout.buffersByLeafId }
  let hydrated = false
  for (const [leafId, ref] of Object.entries(refs)) {
    if (buffers[leafId] !== undefined) {
      continue
    }
    try {
      const buffer = window.api.session.readTerminalScrollback({ ref })
      if (buffer) {
        buffers[leafId] = buffer
        hydrated = true
      }
    } catch {
      // Best-effort restore; failed snapshot reads should not block terminal mount.
    }
  }

  return hydrated
    ? { layout: { ...layout, buffersByLeafId: buffers }, hydrated }
    : { layout, hydrated }
}
