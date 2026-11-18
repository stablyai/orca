// The connector's routes on Orca Cloud (mirror of cloud/packages/connector-contract).
// Every route is POST except hello (PUT), a bot's Slack state and members (GET) and the DELETEs, and
// takes `Authorization: Bearer <connector token>`.
export const CONNECTOR_PATHS = {
  hello: '/v1/connector/hello',
  poll: '/v1/connector/poll',
  acks: '/v1/connector/acks',
  events: '/v1/connector/events',
  replies: '/v1/connector/replies',
  // DELETE `${slackGrants}/<team id>` forgets one.
  slackGrants: '/v1/connector/slack/grants',
  // `${bots}/<bot id>/slack`: GET its state, DELETE its install; POST `…/apps`; GET `…/members?q=`.
  // POST `${bots}/<bot id>/posts` posts as the bot; POST `…/linear/comments` comments on an issue.
  bots: '/v1/connector/bots',
  // PUT one page of this machine's bots, to a cloud listing `bots.pages`; its hello names them all.
  botPages: '/v1/connector/bot-pages',
  // POST `${linear}/connect` and `…/connect/redeem` (connect-messages in the cloud contract);
  // GET `…/state`;
  // DELETE `…/workspaces/<id>` unlinks; GET `…/workspaces/<id>/members?q=`; PUT `…/default-bot`.
  linear: '/v1/connector/linear',
  // GET `${github}/state`; POST `…/connect` and `…/connect/redeem` (as for Linear);
  // DELETE `…/link` unlinks; PUT `…/default-bot`; GET `…/users?q=<username>` finds a GitHub user.
  github: '/v1/connector/github',
  // GET lists pending access requests; POST `…/redeem` {v:1, token} opens one from
  // orca://bot/access-request?t=<token>; POST `…/<request id>/decision` {v:1, decision} closes one.
  accessRequests: '/v1/connector/access-requests'
} as const
