import { createBrowserUuid } from '@/lib/browser-uuid'
import type { TuiAgent } from '../../../shared/agent-launch/catalog/tui-agent'
import type {
  GeneratedInputOutcome,
  GeneratedInputRequest
} from '../../../shared/generated-terminal-input'
import type { HostReply, HostRoute } from '@/runtime/generated-terminal-input-client'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import {
  LOCAL_NOTICE_RUNTIME,
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

/**
 * A request whose failure must stay recoverable. Its one operation id is created here, where the
 * text is accepted, and this window's runtime holds a pending record of it before dispatch, so a
 * renderer reload mid-request loses nothing. The failure then lives in exactly one owner: the host
 * that kept it (found again by the same id after a lost reply), else this window's runtime.
 * Registration never gates the send. True when an owner kept the notice.
 */
export async function deliverKeepingNotice(
  paste: {
    ptyId: string
    content: string
    submit: boolean
    agent?: TuiAgent
  },
  send: GeneratedSend
): Promise<{ outcome: GeneratedInputOutcome; kept: boolean }> {
  const id = createBrowserUuid()
  const notice: GeneratedInputNoticeFields = {
    id,
    text: paste.content,
    agent: paste.agent ?? null,
    certainty: 'unconfirmed',
    ptyId: paste.ptyId,
    ...(paste.submit ? {} : { submitted: false })
  }
  await registerGeneratedInputNotice(LOCAL_NOTICE_RUNTIME, notice, { pending: true })
  // Filled by the send's callbacks: the host's answer (absent for a lost reply) and its route.
  const heard: {
    reply: { noticeRetained: boolean } | null
    route: { target: RuntimeClientTarget; keepsNotices: boolean } | null
  } = { reply: null, route: null }
  const { outcome, hosted } = await send(
    // The client drops these for a host that keeps no notices by id.
    { retainNotice: true, operationId: id },
    (answer) => (heard.reply = answer),
    (where) => (heard.route = where)
  )
  const answered = heard.reply
  const routed = heard.route
  const remoteHost = routed?.target.kind === 'environment' ? routed.target : null
  if (outcome === 'delivered' || outcome === 'staged') {
    settleGeneratedInputNotice(id)
    return { outcome, kept: false }
  }
  if (answered?.noticeRetained) {
    // The host kept it under this id; this window's runtime is that host, or only projected it.
    if (remoteHost) {
      settleGeneratedInputNotice(id)
    }
    return { outcome, kept: true }
  }
  // A lost reply from a host that keeps notices: register the same id there, never resend.
  if (hosted && !answered && remoteHost && routed?.keepsNotices) {
    if (await registerGeneratedInputNotice(remoteHost, notice)) {
      settleGeneratedInputNotice(id)
      return { outcome, kept: true }
    }
  }
  const certainty = outcome === 'unconfirmed' ? 'unconfirmed' : 'not-sent'
  const kept = await registerGeneratedInputNotice(LOCAL_NOTICE_RUNTIME, { ...notice, certainty })
  return { outcome, kept }
}

/** A failure with no send behind it (no terminal yet, held keys, an agent never in front): this
 *  window's runtime keeps it. False when that runtime could not (the caller shows its own). */
export function keepGeneratedInputNotice(args: {
  agent?: TuiAgent | null
  text: string
  certainty?: 'not-sent' | 'unconfirmed'
  submitted?: boolean
}): Promise<boolean> {
  return registerGeneratedInputNotice(LOCAL_NOTICE_RUNTIME, {
    id: createBrowserUuid(),
    text: args.text,
    agent: args.agent ?? null,
    certainty: args.certainty ?? 'not-sent',
    ptyId: null,
    ...(args.submitted === false ? { submitted: false } : {})
  })
}
