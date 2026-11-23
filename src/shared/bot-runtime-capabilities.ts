// Host serves bots to phones: the bot and automation routes, bots.activity and a phone's bots.update. Older hosts lack it, so the page keeps plain folder rows.
export const BOTS_MOBILE_RUNTIME_CAPABILITY = 'bots.mobile.v1' as const

// Host lets a phone create a bot (bots.create); an older host keeps creating on the desktop only.
export const BOTS_CREATE_RUNTIME_CAPABILITY = 'bots.create.v1' as const

export const BOTS_GROUPS_RUNTIME_CAPABILITY = 'bots.groups.v1' as const

// Host signs a bot in to its apps for any device (bots.tools.signIn.*); an older host has no way to from a phone or paired desktop.
export const BOTS_TOOLS_OWNED_SIGN_IN_RUNTIME_CAPABILITY = 'bots.tools.owned-sign-in.v1' as const

// Host sets up its bots' Slack, Linear and GitHub for any paired client (bots.slack/linear/github/connect.*); an older host only from its own window.
export const BOTS_CONNECTORS_RUNTIME_CAPABILITY = 'bots.connectors.v1' as const

// Host creates bots from built-in template packages (bots.create fromTemplate); an older host knows only the
// five seed-only templates, and its enum rejects any other templateId.
export const BOTS_TEMPLATES_RUNTIME_CAPABILITY = 'bots.templates.v2' as const

// Host reads `[Bot: …](bot-chat:<bot>/<chat>)` and tells the agent that chat's `--chat`; an older host
// ignores the link, so a client offers chat picks only where this is advertised.
export const BOTS_CHAT_MENTIONS_RUNTIME_CAPABILITY = 'bots.chat-mentions.v1' as const

// Host checks linked-chat authority at open commit; the served phone page selects the exact item.
export const BOTS_SESSION_LINKS_RUNTIME_CAPABILITY = 'bots.session-links.v1' as const

// Host serves a bot's items to phones (bots.items.owner.* routed for them, Needs you counts on bots.list);
// an older host refuses a phone's item calls, so the phone keeps its bot sheet without Items.
export const BOTS_ITEMS_RUNTIME_CAPABILITY = 'bots.items.v1' as const

// Host takes chat attachments on the owner's item comments (bots.items.owner.comment `images`, store
// `@path`s in text) and mails images to the item's chat; an older host takes text only.
export const BOTS_ITEM_COMMENT_ATTACHMENTS_RUNTIME_CAPABILITY =
  'bots.item-comment-attachments.v1' as const

// Host dedupes the owner's item comments by `requestId` (bots.items.owner.comment): a repeat returns the
// comment already made. An older host refuses the field, so a client sends it only where advertised.
export const BOTS_ITEM_COMMENT_REQUEST_ID_RUNTIME_CAPABILITY =
  'bots.item-comment-request-id.v1' as const

// Host takes `questionId` on the owner's item comments (bots.items.owner.comment) and refuses a comment
// aimed at a question the agent has since replaced. An older host refuses the field.
export const BOTS_ITEM_COMMENT_QUESTION_ID_RUNTIME_CAPABILITY =
  'bots.item-comment-question-id.v1' as const

// Host takes `plain` on the owner's item comments (bots.items.owner.comment): a comment that answers no
// question, even while the agent waits on one. An older host refuses the field.
export const BOTS_ITEM_COMMENT_PLAIN_RUNTIME_CAPABILITY = 'bots.item-comment-plain.v1' as const

// Host takes `skills` on the owner's item comments (bots.items.owner.comment) and names each skill's
// file in the comment's mail. An older host refuses the field.
export const BOTS_ITEM_COMMENT_SKILLS_RUNTIME_CAPABILITY = 'bots.item-comment-skills.v1' as const

// Host stores a picture's background color (bots.update and bots.create `avatarColor`); an older host's strict
// update refuses the field, so clients offer the colors only where this is advertised.
export const BOTS_AVATAR_COLOR_RUNTIME_CAPABILITY = 'bots.avatar-color.v1' as const

// Host stores what a picture wears (bots.update and bots.create `avatarOutfit`); offered only where advertised, as colors are.
export const BOTS_AVATAR_OUTFIT_RUNTIME_CAPABILITY = 'bots.avatar-outfit.v1' as const

// Host keeps a window's drawing of a colored or dressed mascot as the bot's Slack icon (bots.avatar.slackIcon.wanted, .upload, .resend);
// an older host sends Slack the plain mascot, so a window draws one only where this is advertised.
export const BOTS_SLACK_ICON_RUNTIME_CAPABILITY = 'bots.slack-icon.v1' as const

// Host takes chat image attachments on group room posts (bots.groups.send `images`, store `@path`s in text)
// and delivers them as image blocks to addressed members; an older host takes text only.
export const BOTS_GROUP_ATTACHMENTS_RUNTIME_CAPABILITY = 'bots.group-attachments.v1' as const

// Host keeps each bot's Home pinned first and its side chats unpinned in what it serves; an older host
// leaves pins to each client, so a client shows the Home rule only where this is advertised.
export const BOTS_HOME_PIN_RUNTIME_CAPABILITY = 'bots.home-pin.v1' as const

// Host has the Waiting item status (bots.items.owner.status `waiting` with `note`), and clients send it
// too: a host shows Waiting only to a client that reads it, and as In progress to one that doesn't.
export const BOTS_ITEM_WAITING_CAPABILITY = 'bots.item-waiting.v1' as const

export const BOT_RUNTIME_CAPABILITIES = [
  BOTS_GROUPS_RUNTIME_CAPABILITY,
  BOTS_GROUP_ATTACHMENTS_RUNTIME_CAPABILITY,
  BOTS_MOBILE_RUNTIME_CAPABILITY,
  BOTS_SLACK_ICON_RUNTIME_CAPABILITY,
  BOTS_CREATE_RUNTIME_CAPABILITY,
  BOTS_TOOLS_OWNED_SIGN_IN_RUNTIME_CAPABILITY,
  BOTS_CONNECTORS_RUNTIME_CAPABILITY,
  BOTS_TEMPLATES_RUNTIME_CAPABILITY,
  BOTS_CHAT_MENTIONS_RUNTIME_CAPABILITY,
  BOTS_ITEMS_RUNTIME_CAPABILITY,
  BOTS_ITEM_COMMENT_ATTACHMENTS_RUNTIME_CAPABILITY,
  BOTS_ITEM_COMMENT_REQUEST_ID_RUNTIME_CAPABILITY,
  BOTS_ITEM_COMMENT_QUESTION_ID_RUNTIME_CAPABILITY,
  BOTS_ITEM_COMMENT_PLAIN_RUNTIME_CAPABILITY,
  BOTS_ITEM_COMMENT_SKILLS_RUNTIME_CAPABILITY,
  BOTS_SESSION_LINKS_RUNTIME_CAPABILITY,
  BOTS_AVATAR_COLOR_RUNTIME_CAPABILITY,
  BOTS_AVATAR_OUTFIT_RUNTIME_CAPABILITY,
  BOTS_HOME_PIN_RUNTIME_CAPABILITY,
  BOTS_ITEM_WAITING_CAPABILITY
] as const
