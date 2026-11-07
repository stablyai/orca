import { z } from 'zod'
import type {
  GeneratedAgentInputNotice,
  GeneratedInputNoticesPage
} from './generated-agent-input-notice'
import { isTuiAgent } from './agent-launch/catalog/tui-agent-config'
import type { TuiAgent } from './agent-launch/catalog/tui-agent'
import {
  GeneratedInputNoticeProjection,
  type GeneratedInputNoticeDelta
} from './generated-input-notice-projection'

export type { GeneratedInputNoticeDelta }

const frameSchema = z.object({
  id: z.string().min(1),
  agent: z.custom<TuiAgent>((value) => typeof value === 'string' && isTuiAgent(value)).nullable(),
  handle: z.string(),
  worktreeId: z.string(),
  ptyId: z.string().nullable(),
  certainty: z.enum(['not-sent', 'unconfirmed']),
  // Older hosts never send it: their notices are prompts.
  submitted: z.boolean().optional(),
  textLength: z.number().int().min(0),
  offset: z.number().int().min(0),
  chunk: z.string()
})

const messageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), session: z.string().min(1), revision: z.number() }),
  z.object({
    type: z.literal('notice'),
    session: z.string(),
    revision: z.number(),
    frame: frameSchema
  }),
  z.object({
    type: z.literal('dismissed'),
    session: z.string(),
    revision: z.number(),
    id: z.string()
  }),
  z.object({ type: z.literal('end') })
])

export const generatedInputNoticesPageSchema = z.object({
  session: z.string().min(1),
  revision: z.number(),
  frames: z.array(frameSchema),
  next: z.object({ cursor: z.number(), offset: z.number() }).nullable(),
  withheld: z.array(z.string()).optional()
})

export type GeneratedInputNoticeFeed = {
  /** One message from terminal.generatedInputNotices.subscribe. */
  receive: (message: unknown) => void
  stop: () => void
  /** Retry a failed snapshot on a real lifecycle or feed wake. */
  retry: () => void
}

/** Drives one runtime's notice view: listen first, then pull the snapshot one bounded page at a
 *  time (each request is the backpressure), applying live changes as they arrive. */
export function createGeneratedInputNoticeFeed(deps: {
  readPage: (from: { cursor: number; offset: number } | undefined) => Promise<unknown>
  /** The whole complete view, after a (re)subscription's snapshot: reconcile against it. */
  onSnapshot: (notices: GeneratedAgentInputNotice[], session: string, withheld: string[]) => void
  /** One live complete notice added or dismissed: apply it to the consumer's indexed view. */
  onDelta: (delta: GeneratedInputNoticeDelta, session: string) => void
}): GeneratedInputNoticeFeed {
  const projection = new GeneratedInputNoticeProjection()
  let stopped = false
  let revision = 0
  let reading = false
  let failed = false
  let wake = false
  let resnapshot = false
  let requestedSession: string | null = null
  // Only a complete snapshot speaks for the host; after it, a live change touches only itself.
  let withheld: string[] = []
  const publish = (): void => {
    const session = projection.currentSession
    if (stopped || !session || !projection.isSynced) {
      return
    }
    const changes = projection.takeChanges()
    if ('full' in changes) {
      deps.onSnapshot(changes.full, session, withheld)
      return
    }
    for (const delta of changes.deltas) {
      deps.onDelta(delta, session)
    }
  }
  const readSnapshot = async (token: number): Promise<boolean> => {
    let from: { cursor: number; offset: number } | undefined
    do {
      const parsed = generatedInputNoticesPageSchema.safeParse(await deps.readPage(from))
      // An unreadable or superseded page ends this snapshot without deleting anything.
      if (stopped || !parsed.success || !projection.isCurrent(token)) {
        return false
      }
      const page: GeneratedInputNoticesPage = parsed.data
      if (!from) {
        withheld = []
      }
      for (const id of page.withheld ?? []) {
        withheld.push(id)
      }
      for (const frame of page.frames) {
        projection.applyFrame(page.session, frame, token)
      }
      from = page.next ?? undefined
    } while (from)
    if (requestedSession !== projection.currentSession) {
      return false
    }
    projection.finish(token)
    publish()
    return true
  }
  const resync = (session: string, force = false): void => {
    requestedSession = session
    if (reading) {
      wake = true
      resnapshot ||= force
      return
    }
    if (stopped) {
      return
    }
    reading = true
    failed = false
    wake = false
    resnapshot = false
    void readSnapshot(projection.begin(session))
      .catch(() => false)
      .then((complete) => {
        reading = false
        failed = !complete
        if (!stopped && (resnapshot || requestedSession !== session || (failed && wake))) {
          resync(requestedSession!)
        }
      })
  }
  const retry = (): void => {
    if (reading) {
      wake = true
    } else if (failed && requestedSession) {
      resync(requestedSession)
    }
  }
  return {
    retry,
    receive: (raw) => {
      const parsed = messageSchema.safeParse(raw)
      if (stopped || !parsed.success) {
        return
      }
      const message = parsed.data
      if (message.type === 'ready') {
        revision = message.revision
        resync(message.session)
      } else if (message.type === 'notice' || message.type === 'dismissed') {
        retry()
        // A skipped revision lost a change (a dropped frame): read the host's state again.
        if (message.revision > revision + 1) {
          revision = message.revision
          resync(message.session, true)
          return
        }
        revision = Math.max(revision, message.revision)
        if (message.type === 'notice') {
          projection.applyFrame(message.session, message.frame)
        } else {
          projection.dismiss(message.session, message.id)
        }
      }
      publish()
    },
    stop: () => {
      stopped = true
    }
  }
}
