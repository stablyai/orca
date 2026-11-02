import { z } from 'zod'
import type {
  GeneratedAgentInputNotice,
  GeneratedInputNoticesPage
} from './generated-agent-input-notice'
import { isTuiAgent } from './tui-agent-config'
import type { TuiAgent } from './tui-agent'
import { GeneratedInputNoticeProjection } from './generated-input-notice-projection'

const frameSchema = z.object({
  id: z.string().min(1),
  agent: z.custom<TuiAgent>((value) => typeof value === 'string' && isTuiAgent(value)),
  handle: z.string(),
  worktreeId: z.string(),
  ptyId: z.string().nullable(),
  certainty: z.enum(['not-sent', 'unconfirmed']),
  textLength: z.number().int().min(0),
  offset: z.number().int().min(0),
  chunk: z.string()
})

const messageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), session: z.string().min(1) }),
  z.object({ type: z.literal('notice'), session: z.string(), frame: frameSchema }),
  z.object({ type: z.literal('dismissed'), session: z.string(), id: z.string() }),
  z.object({ type: z.literal('end') })
])

export const generatedInputNoticesPageSchema = z.object({
  session: z.string().min(1),
  revision: z.number(),
  frames: z.array(frameSchema),
  next: z.object({ cursor: z.number(), offset: z.number() }).nullable()
})

export type GeneratedInputNoticeFeed = {
  /** One message from terminal.generatedInputNotices.subscribe. */
  receive: (message: unknown) => void
  stop: () => void
}

/** Drives one runtime's notice view: listen first, then pull the snapshot one bounded page at a
 *  time (each request is the backpressure), applying live changes as they arrive. */
export function createGeneratedInputNoticeFeed(deps: {
  readPage: (from: { cursor: number; offset: number } | undefined) => Promise<unknown>
  onChange: (notices: GeneratedAgentInputNotice[], session: string) => void
}): GeneratedInputNoticeFeed {
  const projection = new GeneratedInputNoticeProjection()
  let stopped = false
  const publish = (): void => {
    if (!stopped && projection.currentSession) {
      deps.onChange(projection.complete(), projection.currentSession)
    }
  }
  const readSnapshot = async (token: number): Promise<void> => {
    let from: { cursor: number; offset: number } | undefined
    do {
      const parsed = generatedInputNoticesPageSchema.safeParse(await deps.readPage(from))
      // An unreadable or superseded page ends this snapshot without deleting anything.
      if (stopped || !parsed.success || !projection.isCurrent(token)) {
        return
      }
      const page: GeneratedInputNoticesPage = parsed.data
      for (const frame of page.frames) {
        projection.applyFrame(page.session, frame, token)
      }
      from = page.next ?? undefined
    } while (from)
    projection.finish(token)
    publish()
  }
  return {
    receive: (raw) => {
      const parsed = messageSchema.safeParse(raw)
      if (stopped || !parsed.success) {
        return
      }
      const message = parsed.data
      if (message.type === 'ready') {
        void readSnapshot(projection.begin(message.session)).catch(() => {})
      } else if (message.type === 'notice') {
        projection.applyFrame(message.session, message.frame)
      } else if (message.type === 'dismissed') {
        projection.dismiss(message.session, message.id)
      }
      publish()
    },
    stop: () => {
      stopped = true
    }
  }
}
