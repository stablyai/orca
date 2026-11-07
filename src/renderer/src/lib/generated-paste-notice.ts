import { createBrowserUuid } from '@/lib/browser-uuid'
import type { TuiAgent } from '../../../shared/agent-launch/catalog/tui-agent'
import type {
  GeneratedInputOutcome,
  GeneratedInputRequest
} from '../../../shared/generated-terminal-input'
import type { HostReply, HostRoute } from '@/runtime/generated-terminal-input-client'
import {
  generatedInputNoticeWindow,
  holdGeneratedInputNotice,
  registerGeneratedInputNotice,
  settleGeneratedInputNotice,
  type GeneratedInputNoticeFields
} from '@/runtime/generated-input-notice-registration'

/** One send attempt: `hosted` is false when an older host left the write to this client. */
export type GeneratedSend = (
  request: Pick<GeneratedInputRequest, 'retainNotice' | 'operationId'>,
  onReply: HostReply,
  onRoute: HostRoute
) => Promise<{ outcome: GeneratedInputOutcome; hosted: boolean }>

/** Text accepted for delivery becomes this window's runtime's obligation at once, before any
 *  wait for a terminal or for readiness, under one operation id that the request then carries.
 *  Nothing waits on that handoff. Until it is handed to delivery nothing was written, so a reload
 *  meanwhile shows it as not sent. */
export function acceptGeneratedInput(args: {
  text: string
  agent?: TuiAgent | null
  submit: boolean
  ptyId?: string | null
  operationId?: string
}): string {
  const id = args.operationId ?? createBrowserUuid()
  holdGeneratedInputNotice(noticeFields(id, args))
  return id
}

function noticeFields(
  id: string,
  args: { text: string; agent?: TuiAgent | null; submit: boolean; ptyId?: string | null }
): GeneratedInputNoticeFields {
  return {
    id,
    text: args.text,
    agent: args.agent ?? null,
    certainty: 'not-sent',
    ptyId: args.ptyId ?? null,
    ...(args.submit ? {} : { submitted: false })
  }
}

/**
 * A request whose failure must stay recoverable, under the operation id its text was accepted with
 * (or one made now). This window's runtime holds a pending record of it, never waited on, so a
 * renderer reload mid-request loses nothing; it reads as not sent until the request is handed to a
 * transport or this client starts writing it itself. Once the route is known the record names the
 * paired host that runs it, and this window's runtime alone gives that host a copy if its answer
 * is lost. The failure then lives in exactly one owner: the host that kept it, else this window's
 * runtime. True when an owner kept it.
 */
export async function deliverKeepingNotice(
  paste: {
    ptyId: string
    content: string
    submit: boolean
    agent?: TuiAgent
    operationId?: string
  },
  send: GeneratedSend
): Promise<{ outcome: GeneratedInputOutcome; kept: boolean }> {
  const fields = {
    text: paste.content,
    agent: paste.agent,
    submit: paste.submit,
    ptyId: paste.ptyId
  }
  const id = paste.operationId ?? createBrowserUuid()
  const notice = noticeFields(id, fields)
  holdGeneratedInputNotice(notice)
  // Filled by the send's callbacks: the host's answer (absent for a lost reply).
  const heard: { reply: { noticeRetained: boolean } | null } = { reply: null }
  const { outcome } = await send(
    // The client drops these for a host that keeps no notices by id.
    { retainNotice: true, operationId: id },
    (answer) => (heard.reply = answer),
    (where) => {
      // The window's record names the host that will hold the authoritative one, with the
      // receipt the request is fixed to.
      if (where.target.kind === 'environment' && where.keepsNotices) {
        holdGeneratedInputNotice(notice, {
          owner: {
            window: generatedInputNoticeWindow(),
            ...where.receipt,
            environmentId: where.target.environmentId
          }
        })
      }
    }
  )
  if (outcome === 'delivered' || outcome === 'staged') {
    settleGeneratedInputNotice(id)
    return { outcome, kept: false }
  }
  if (heard.reply?.noticeRetained) {
    // The host kept it under this id; this window's runtime is that host, or held only a copy.
    settleGeneratedInputNotice(id)
    return { outcome, kept: true }
  }
  // Shown by this window's runtime; after a lost reply that runtime gives the host the same id,
  // never a resend.
  const kept = await registerGeneratedInputNotice({
    ...notice,
    certainty: outcome === 'unconfirmed' ? 'unconfirmed' : 'not-sent'
  })
  if (outcome === 'target-gone') {
    // Nothing was written: the same operation may move to a fresh target.
    holdGeneratedInputNotice(notice, { targetGone: true })
  }
  return { outcome, kept }
}

/** A failure with no send behind it (no terminal yet, held keys, an agent never in front): this
 *  window's runtime keeps it, under the id its text was accepted with when there was one. False
 *  when that runtime could not (the caller shows its own). */
export function keepGeneratedInputNotice(args: {
  agent?: TuiAgent | null
  text: string
  certainty?: 'not-sent' | 'unconfirmed'
  submitted?: boolean
  operationId?: string
}): Promise<boolean> {
  return registerGeneratedInputNotice({
    ...noticeFields(args.operationId ?? createBrowserUuid(), {
      text: args.text,
      agent: args.agent,
      submit: args.submitted !== false
    }),
    certainty: args.certainty ?? 'not-sent'
  })
}
