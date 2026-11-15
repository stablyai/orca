/** What a coordinator can do after a worker's task finished; the runtime decides, every renderer prints it. */
export type ReportFollowUpAction =
  // `active`: the report's task already has a follow-up running, which the send steers.
  | { kind: 'send'; dispatchId: string; active: boolean }
  | { kind: 'worker_start_on'; server: string }
  | { kind: 'worker_start' }

export function formatReportFollowUpCommand(action: ReportFollowUpAction, cli = 'orca'): string {
  switch (action.kind) {
    case 'send':
      return `${cli} orchestration send --to dispatch:${action.dispatchId} --subject "..." --body "..."`
    case 'worker_start_on':
      return `${cli} orchestration worker-start --on ${quoteServerName(action.server)} --spec "..."`
    case 'worker_start':
      return `${cli} orchestration worker-start --spec "..."`
  }
}

// Saved server names are free text; quoting keeps a name with spaces one argument.
function quoteServerName(name: string): string {
  return /^[\w.:@/-]+$/.test(name) ? name : `"${name.replace(/["\\$`]/g, '\\$&')}"`
}

/** The action line every view prints under a finished task's report, and the refusal repeats. */
export function formatReportFollowUpLine(action: ReportFollowUpAction, cli = 'orca'): string {
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
