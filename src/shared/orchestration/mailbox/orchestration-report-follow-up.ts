/** What to do with mail `reply` would refuse: a finished worker's report, or a bot's mail sent to someone
 *  else; or, for status a bot got from another, that there is nothing to answer. The runtime decides,
 *  every renderer prints it. */
export type ReportFollowUpAction =
  // `active`: the report's task already has a follow-up running, which the send steers.
  | { kind: 'send'; dispatchId: string; active: boolean }
  | { kind: 'worker_start_on'; server: string }
  | { kind: 'worker_start' }
  // New mail to the sender: `chat` names the bot chat that sent it, when `to` is `bot:<name>`.
  | { kind: 'mail_sender'; to: string; chat?: string }
  | { kind: 'information' }

type FollowUpCommandAction = Exclude<ReportFollowUpAction, { kind: 'information' }>

export function formatReportFollowUpCommand(action: FollowUpCommandAction, cli = 'orca'): string {
  switch (action.kind) {
    case 'send':
      return `${cli} orchestration send --to dispatch:${action.dispatchId} --subject "..." --body "..."`
    case 'worker_start_on':
      return `${cli} orchestration worker-start --on ${quoteArgument(action.server)} --spec "..."`
    case 'worker_start':
      return `${cli} orchestration worker-start --spec "..."`
    case 'mail_sender':
      // Mail to a bot's chat is a request, so it names one of the request types.
      return action.chat
        ? `${cli} orchestration send --to ${quoteArgument(action.to)} --chat ${action.chat} --type question --subject "..." --body "..."`
        : `${cli} orchestration send --to ${quoteArgument(action.to)} --subject "..." --body "..."`
  }
}

// Saved server and bot names are free text; quoting keeps a name with spaces one argument.
function quoteArgument(name: string): string {
  return /^[\w.:@/-]+$/.test(name) ? name : `"${name.replace(/["\\$`]/g, '\\$&')}"`
}

/** The action line every view prints under a finished task's report, and the refusal repeats. */
export function formatReportFollowUpLine(action: ReportFollowUpAction, cli = 'orca'): string {
  if (action.kind === 'information') {
    return 'For your information: there is nothing to answer'
  }
  const command = formatReportFollowUpCommand(action, cli)
  switch (action.kind) {
    case 'send':
      return action.active
        ? `Its follow-up ${action.dispatchId} is running; to message it: ${command}`
        : `To give this worker more work: ${command}`
    case 'worker_start_on':
      return `To start more work on ${action.server}: ${command}`
    case 'worker_start':
      return `To start a new worker: ${command}`
    case 'mail_sender':
      return `To answer its sender: ${command}`
  }
}

export function formatReportFollowUpNext(action: ReportFollowUpAction): string {
  return `${formatReportFollowUpLine(action)}.`
}

export function formatFinishedReportReplyRefusal(
  reportDispatchId: string,
  action: ReportFollowUpAction
): string {
  return `The task behind this report (Dispatch ${reportDispatchId}) finished, so a reply would never reach its worker; nothing was sent. ${formatReportFollowUpNext(action)} To just acknowledge the report, do nothing.`
}

export function formatNotYoursReplyRefusal(action: ReportFollowUpAction | undefined): string {
  return `That message wasn't sent to you, so a reply to it was refused and nothing was sent.${action ? ` ${formatReportFollowUpNext(action)}` : ''}`
}
