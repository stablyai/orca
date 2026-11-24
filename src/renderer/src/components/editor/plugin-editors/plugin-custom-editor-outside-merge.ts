/**
 * One outside merge in flight between Orca and an editor frame. It settles only on the session's
 * acknowledgement: the first accepted edit made against the merge's own document version, whose
 * text is the merged result. A merge that throws, a disposed session, a remount or silence past
 * the deadline settles with null, and Orca keeps its banner.
 */
export type PendingOutsideMerge = {
  /** Starts a merge for the document version just sent; a previous one settles with null. */
  begin(version: number, timeoutMs: number): Promise<string | null>
  /** An accepted text edit; true when it is the acknowledgement, which settles the merge. */
  accept(baseVersion: number, text: string): boolean
  cancel(): void
}

export function createPendingOutsideMerge(): PendingOutsideMerge {
  let pending: { version: number; settle: (text: string | null) => void } | null = null
  const finish = (text: string | null): void => {
    const current = pending
    pending = null
    current?.settle(text)
  }
  return {
    begin(version, timeoutMs) {
      finish(null)
      return new Promise((resolve) => {
        const timer = setTimeout(() => finish(null), timeoutMs)
        pending = {
          version,
          settle: (text) => {
            clearTimeout(timer)
            resolve(text)
          }
        }
      })
    },
    accept(baseVersion, text) {
      if (pending?.version !== baseVersion) {
        return false
      }
      finish(text)
      return true
    },
    cancel: () => finish(null)
  }
}
