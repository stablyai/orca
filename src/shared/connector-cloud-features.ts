// What an Orca Cloud takes beyond the contract version, from its hello answer; this Orca sends those
// only to a cloud that lists them.
export const CONNECTOR_CLOUD_FEATURES = [
  'review',
  'workers',
  'webhooks',
  'triggers.inThread',
  // `connector.act` (connector-action-contract.ts).
  'actions',
  // A rule's places and subject may be refs, and find takes `of` and marks exact matches.
  'refs',
  // A rule's `from` and `onOwnerMessage`.
  'triggers.people',
  // A bot's own Slack app in several workspaces; an older cloud refuses a second one.
  'slack.teams',
  // `connector.act` places, and a whole workspace (linear:<org>:workspace) as a rule's place.
  'places',
  // find's `search` (connector-action-contract.ts), on the sources whose find capability lists it.
  'find.search',
  // The set verb's `fields`, on the sources whose set capability is on.
  'set',
  // post's `title`, `fields` and `parent`: a new issue, on the sources whose post capability lists it.
  'create',
  // More bots than one hello lists go in pages its hello names; an older cloud takes the first page.
  'bots.pages',
  // reply's `stage` and `files`: a reply's words and several files as one post.
  'reply.files',
  // One chat owns a thread: the acts-for and unlinked events, and the chat_gone refusal.
  'threads.owner',
  // A rule's `fromOwner`: a GitHub pull request the owner opened starts it, and comes with its head.
  'triggers.own',
  // GitHub's newer events (GITHUB2_EVENT_KINDS in automation-event-triggers.ts) and a rule's `label`.
  'triggers.github2',
  // github.workflow_finished and a rule's `run` (WORKFLOW_EVENT_KINDS in automation-github-triggers.ts).
  'triggers.workflows',
  // github.ci_finished (CI_FINISHED_EVENT_KINDS in automation-github-triggers.ts).
  'triggers.ci_finished',
  // A file's bytes go straight between the CLI and the source: reply and attach stage an `upload`
  // and post its `files`; read's `stream` answers a link to the bytes. No Orca size cap.
  'files.direct',
  // The owner's Orca-typed messages post into the chat's Slack thread (connector-slack-mirror-contract.ts).
  'slack.mirror'
] as const
export type ConnectorCloudFeature = (typeof CONNECTOR_CLOUD_FEATURES)[number]

/** The cloud reads a prompt's `raisedBy` and routes or masks it by it, so a bot link's prompts from
 *  turns its conversation didn't ask for may go to it. Its own constant, as the cloud's contract
 *  keeps it: without it this Orca sends those prompts nowhere. */
export const CONNECTOR_CLOUD_PROMPTS_AUDIENCE_FEATURE = 'prompts.audience'

/** The cloud takes a turn's answer up to maxLongAnswerBytes; without it this Orca keeps to
 *  maxLastAssistantMessageBytes. Its own constant, as the cloud's contract keeps it. */
export const CONNECTOR_CLOUD_LONG_ANSWERS_FEATURE = 'answers.long'

/** The cloud takes a post's `postAt` and has the source post it then. Its own constant, as the
 *  cloud's contract keeps it. */
export const CONNECTOR_CLOUD_POST_SCHEDULE_FEATURE = 'post.schedule'

/** The cloud takes the verbs for Slack's own surfaces (pin, canvas, list, scheduled). Its own
 *  constant, as the cloud's contract keeps it. */
export const CONNECTOR_CLOUD_SLACK_TOOLS_FEATURE = 'slack.tools'

/** The cloud takes a reply's `choices` and routes a press of one as its presser's message. Its own
 *  constant, as the cloud's contract keeps it. */
export const CONNECTOR_CLOUD_REPLY_CHOICES_FEATURE = 'reply.choices'

/** The cloud takes the `activity` event and shows what a running turn is doing. Its own constant,
 *  as the cloud's contract keeps it. */
export const CONNECTOR_CLOUD_TURN_ACTIVITY_FEATURE = 'turn.activity'

/** The cloud filters channel thread replies before delivery using a bot's slackThreadReplies.
 *  Advertised only by an implementation that also preserves skipped messages as thread context. */
export const CONNECTOR_CLOUD_SLACK_THREAD_REPLIES_FEATURE = 'slack.threadReplies'

/** Listed by this Orca, which keeps a reply outbox, and by a cloud that takes its `reply` events
 *  (design item 125). Its own constant, as the cloud's contract keeps it. */
export const CONNECTOR_REPLIES_OUTBOX_FEATURE = 'replies.outbox'

/** The cloud shows a usage-limit pause this Orca will resume (turn-ended `resumes`) as paused. Its
 *  own constant, as the cloud's contract keeps it. */
export const CONNECTOR_REPLIES_PAUSED_FEATURE = 'replies.paused'

/** This Orca takes a send's `resume` (Resume on a failed turn's status). Its own constant, as the
 *  cloud's contract keeps it. */
export const CONNECTOR_RESUME_FEATURE = 'resume'
