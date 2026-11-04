// Window still captures agent resume records; main must record every change because layout frames omit them.

import { useAppStore } from '@/store'
import { recordSleepingRecordChangesThroughLayoutOwner } from '@/store/terminals/terminal-sleep-layout-owner'
import { resolveOwner } from '@/lib/resolve-owner'
import { structuralValuesEqualIgnoringUndefined } from '../../../shared/structural-value-equality'

let following = false
let reconciling = false

/** After restore, whose records are main's own: from then on main gets each change. */
export function followSleepingRecordsInLayoutOwner(): void {
  // Kept for the document's life, like the window's layout stream.
  if (following) {
    return
  }
  following = true
  useAppStore.subscribe((state, previous) => {
    if (
      !reconciling &&
      state.sleepingAgentSessionsByPaneKey !== previous.sleepingAgentSessionsByPaneKey
    ) {
      recordSleepingRecordChangesThroughLayoutOwner(
        state,
        previous.sleepingAgentSessionsByPaneKey,
        state.sleepingAgentSessionsByPaneKey,
        (worktreeId, paneKeys) => {
          const owner = resolveOwner(state, { workspaceId: worktreeId })
          if (owner.kind !== 'resolved' || owner.owner.endpoint.kind !== 'self') {
            return
          }
          void window.api.session.get(owner.owner.at).then(
            (session) => {
              reconciling = true
              try {
                useAppStore.setState((current) => {
                  const records = { ...current.sleepingAgentSessionsByPaneKey }
                  let changed = false
                  for (const key of paneKeys) {
                    if (
                      !structuralValuesEqualIgnoringUndefined(
                        records[key],
                        state.sleepingAgentSessionsByPaneKey[key]
                      )
                    ) {
                      continue
                    }
                    const accepted = session.sleepingAgentSessionsByPaneKey?.[key]
                    if (accepted) {
                      records[key] = accepted
                    } else {
                      delete records[key]
                    }
                    changed = true
                  }
                  return changed ? { sleepingAgentSessionsByPaneKey: records } : current
                })
              } finally {
                reconciling = false
              }
            },
            (error: unknown) =>
              console.warn('[layout-owner] resume records could not reload', error)
          )
        }
      )
    }
  })
}
