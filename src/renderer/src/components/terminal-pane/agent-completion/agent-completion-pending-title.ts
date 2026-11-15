const INSPECTION_TIMEOUT_MS = 15_000
const PENDING_TITLE_TTL_MS = Math.max(2_000, INSPECTION_TIMEOUT_MS + 500)
const PENDING_TITLE_MAX_TTL_MS = Math.max(30_000, PENDING_TITLE_TTL_MS)

type PendingTitle = {
  id: number
  title: string
  expiresAt: number
  maxExpiresAt: number
  firstInspectionFinished: boolean
  validatedByFreshInspection: boolean
}

type PendingTitleControllerOptions = {
  hasAgentEvidence: () => boolean
  onEligible: (title: string) => void
  onExpired: () => void
  requestInspection: () => void
  schedulePoll: () => void
}

export type PendingTitleController = {
  get: () => PendingTitle | null
  hold: (title: string) => void
  drop: () => void
  finishInspection: (id: number, succeeded: boolean, recognized: boolean) => void
  clearTimer: () => void
}

export function createPendingTitleController({
  hasAgentEvidence,
  onEligible,
  onExpired,
  requestInspection,
  schedulePoll
}: PendingTitleControllerOptions): PendingTitleController {
  let pending: PendingTitle | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let nextId = 0

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  function scheduleExpiry(): void {
    clearTimer()
    if (!pending) {
      return
    }
    const remaining = pending.expiresAt - Date.now()
    if (remaining <= 0) {
      pending = null
      schedulePoll()
      onExpired()
      return
    }
    timer = setTimeout(() => {
      timer = null
      if (!pending) {
        return
      }
      if (!pending.firstInspectionFinished && Date.now() < pending.maxExpiresAt) {
        pending.expiresAt = Math.min(Date.now() + 500, pending.maxExpiresAt)
        scheduleExpiry()
        return
      }
      pending = null
      schedulePoll()
      onExpired()
    }, remaining)
  }

  return {
    get: () => pending,
    hold: (title) => {
      const now = Date.now()
      pending = {
        id: ++nextId,
        title,
        expiresAt: Math.min(now + PENDING_TITLE_TTL_MS, now + PENDING_TITLE_MAX_TTL_MS),
        maxExpiresAt: now + PENDING_TITLE_MAX_TTL_MS,
        firstInspectionFinished: false,
        validatedByFreshInspection: false
      }
      scheduleExpiry()
      requestInspection()
    },
    drop: () => {
      clearTimer()
      pending = null
    },
    finishInspection: (id, succeeded, recognized) => {
      if (!pending || pending.id !== id) {
        return
      }
      pending.firstInspectionFinished = true
      if (succeeded && recognized && hasAgentEvidence()) {
        pending.validatedByFreshInspection = true
        onEligible(pending.title)
      } else if (!succeeded) {
        pending = null
      }
      scheduleExpiry()
    },
    clearTimer
  }
}
