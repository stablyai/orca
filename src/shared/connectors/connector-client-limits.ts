export const CONNECTOR_CLIENT_LIMITS = {
  pollTimeoutMs: 70_000,
  minDeadlineLeftMs: 10_000,
  maxLastAssistantMessageBytes: 8 * 1024,
  // One reply event's deliveries.
  maxReplyDeliveryIds: 100,
  // The cloud refuses a larger request body with 413.
  maxRequestBytes: 1024 * 1024,
  // One event's JSON, so any single event fits in an events request.
  maxEventBytes: 192 * 1024,
  // A snapshot lists linked conversations active in the last 7 days, newest first, up to this many.
  maxSnapshotConversations: 200,
  snapshotActiveWindowMs: 7 * 24 * 60 * 60 * 1000,
  maxDisplayTextLength: 200,
  // A hello (or one bot page) lists at most this many bots, each with at most maxBotMembers member ids.
  maxHelloBots: 20,
  // Pages of maxHelloBots bots a hello may name, to a cloud listing `bots.pages`.
  maxBotPages: 100,
  maxBotIdLength: 128,
  maxBotMembers: 200,
  maxBotMemberIdLength: 32,
  maxBotWorkspaceMemberIdLength: 64,
  maxBotWorkspaceMembers: 50,
  maxBotHandleLength: 64,
  // A reply's inline review notes.
  maxReviewComments: 30,
  maxReviewPathLength: 256,
  maxReviewCommentChars: 1_000,
  // One per Linear workspace or GitHub installation.
  maxBotWorkspaces: 8,
  // Slack's rows beside those, from a cloud with `slack.teams`: together at most maxBotMembers people.
  maxBotSlackWorkspaces: 8,
  // A hello lists at most this many event rules of bot automations.
  maxHelloTriggers: 100
} as const
