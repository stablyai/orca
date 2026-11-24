// A failed Connect Slack's codes under Details, the same lines on the desktop and the phone.

export type SlackSetupProblem =
  | { kind: 'reconnecting' | 'offline'; code: string; environmentId: string }
  | { kind: 'other-user' | 'expired'; teamId: string }
  /** `mine`: this desktop's own token was refused, so the new one is saved here. */
  | { kind: 'token-rejected'; code: string; teamId?: string; mine?: true }

function problemCode(problem: SlackSetupProblem): string {
  switch (problem.kind) {
    case 'other-user':
      return 'other_user'
    case 'expired':
      return 'link_expired'
    case 'reconnecting':
    case 'offline':
    case 'token-rejected':
      return problem.code || 'unknown'
  }
}

/** The technical lines under Details, for whoever reads them out to support. */
export function slackSetupProblemDetails(
  problem: SlackSetupProblem,
  where: { botName: string; hostName: string | null }
): string {
  const teamId = 'teamId' in problem ? problem.teamId : undefined
  return [
    `code: ${problemCode(problem)}`,
    `computer: ${where.hostName ?? 'this computer'}`,
    `bot: ${where.botName}`,
    ...(problem.kind === 'reconnecting' || problem.kind === 'offline'
      ? [`connection: ${problem.kind}`]
      : []),
    ...(teamId ? [`workspace: ${teamId}`] : [])
  ].join('\n')
}
