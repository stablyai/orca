// One English table for bot failures people see: main keeps the English for the CLI and older
// clients and sends the code with it, and each client translates by code.
import type { BotChatTranslate } from './bot-chat-tree'

export const BOT_FAILURE_COPY = {
  lookUnfinished: "The last look didn't finish.",
  lookTimedOut: 'The last look was stopped after {{minutes}} min.',
  lookInterrupted: 'Orca stopped during the last look.',
  lookCouldNotStart: "The last look couldn't start.",
  lookAsleep: 'The last look was missed because this computer was asleep.',
  tidyUpUnfinished: "The last tidy-up didn't finish.",
  tidyUpTimedOut: 'The last tidy-up was stopped after {{minutes}} min.',
  tidyUpCouldNotStart: "The last tidy-up couldn't start.",
  tidyUpAsleep: 'The last tidy-up was missed because this computer was asleep.',
  tidyUpUnreadChats: "The last tidy-up couldn't read its chats, so it didn't run.",
  tidyUpNoDraft: "The last tidy-up didn't reply with a new MEMORY.md.",
  tidyUpNoOps: "The last tidy-up's reply wasn't a list of changes Orca could read.",
  tidyUpAllSkipped:
    'Orca skipped every change the last tidy-up asked for, so nothing changed. ({{detail}})',
  tidyUpNotListLines:
    "The last tidy-up didn't run: MEMORY.md has more than a few lines that aren't list lines, and ops Tidy-up reads only list lines.",
  tidyUpMovedOnly:
    'The last tidy-up moved status lines to memory/journal/, but Orca could not use the rest of its reply. ({{detail}})',
  tidyUpBadTopic: "The last tidy-up named a topic file Orca can't write, so nothing changed.",
  tidyUpTooLong:
    "The last tidy-up's MEMORY.md was over {{max}} lines and no shorter, so nothing changed.",
  tidyUpTooManyRemoved: 'The last tidy-up took out too many lines at once, so nothing changed.',
  tidyUpTooManyAdded: 'The last tidy-up added too many new lines at once, so nothing changed.',
  tidyUpNotCopied:
    "The last tidy-up filed a line MEMORY.md doesn't have; new facts go in MEMORY.md, so nothing changed.",
  tidyUpTooManyFiled: 'The last tidy-up filed more than {{max}} lines at once, so nothing changed.',
  tidyUpChanged: 'MEMORY.md changed during the last tidy-up, so nothing changed.',
  tidyUpNotApplied: "The last tidy-up's changes couldn't be saved, so nothing changed.",
  toolGone: 'This bot no longer has that tool.',
  toolDetailsInvalid: 'Tool details are invalid. Check the name, URL or executable and values.',
  toolDestinationChanged:
    'The credential destination changed. Re-enter saved values or remove their rows.',
  toolSavedValueGone: 'That saved value is no longer available. Re-enter it or remove its row.',
  toolValueMissing: 'Enter a value for each row, or remove the row.',
  toolCredentialsUnreadable:
    'The bot’s saved tool credentials are unreadable. Re-enter the tool’s values.',
  toolSignInManaged: 'Orca signs in to this tool. Sign it in or out instead.',
  toolCredentialsRaced: 'The bot’s tool credentials changed in another Orca. Try again.',
  toolSourceManaged: 'Orca manages this tool. Change it where you set it up.',
  toolValuesUnmoved: 'A tool still holds its saved values. Reopen the bot’s tools to move them.',
  toolCodexCheckFailed:
    'Codex could not check or connect the tools. Check its setup and try again.',
  toolCodexNoThread: 'Codex started no thread to check the tools in.',
  toolSignInFolderFailed: "Couldn't prepare the sign-in folder: {{detail}}",
  toolClaudePrepareFailed:
    "Couldn't prepare {{name}} in Claude Code. Check its tool configuration.",
  toolNameTaken: 'This bot already has a tool named {{name}}.',
  toolNameTakenByAgent:
    'Your {{agent}} already has a tool named {{name}}, which this bot gets too. Pick another name with --name.',
  toolNameTakenByCodexStdio:
    "Your Codex already has a local tool named {{name}}, so this bot's {{name}} can't run. Rename this bot's tool.",
  toolNotUpdated: 'The tool was not updated.',
  toolSignInAddressIncomplete: 'Paste the whole address the sign-in page ended on.',
  toolSignInAddressWrong:
    "That isn't the address this sign-in ends on. Start it again with Connect, sign in, then paste the address your browser shows.",
  toolSignInEnded: 'The sign-in had already ended or timed out. Start it again with Connect.',
  toolNotFound: 'This bot has no tool named {{name}}.',
  toolNeedsNoSignIn: '{{name}} uses its saved values and needs no sign-in.',
  toolSignInAgentUnsupported:
    'Orca signs {{name}} in only for Claude Code and Codex. Add it with its sign-in values instead.',
  toolCodexNoSignInPage: 'Codex gave no sign-in page for {{name}}.',
  toolClaudeSignInFailed: "Claude couldn't start signing in to {{name}}.",
  toolClaudeNoSignInPage: "Claude didn't open a sign-in page for {{name}}.",
  groupMessageIdReused: 'Message identity was already used.',
  groupChangedBeforeSend: 'The group changed. Review the current members before sending.',
  groupEmptyBeforeSend: 'Every bot has left this group. Add a bot before sending.',
  groupRequestUnverifiable: 'The original queued group request cannot be verified.',
  groupTurnInactive: 'This group request or member is no longer active.',
  groupBotUnavailable: 'This bot is paused or unavailable. No other bot was substituted.',
  groupBotTwice: 'Choose each bot once.',
  groupBotGone: 'A selected bot is no longer available.',
  groupLocalOnly: 'Groups currently support bots on this local execution host only.',
  groupChanged: 'The group changed. Reopen this dialog and try again.',
  groupReplierGone: 'Choose a current member in Room replies.',
  groupEmptyBeforeThread: 'Every bot has left this group. Add a bot before starting a thread.',
  groupNeedsLocalBot: 'This group needs at least one bot on this computer.',
  groupNameTaken:
    '{{name}} is already in this group. Members need different names so mentions stay unambiguous.',
  groupPostFromHost: 'To post in a group with bots on other computers, use {{host}}.',
  groupPeerTooOld: 'Update Orca on {{host}} to add its bots to a group.',
  groupMentionAmbiguous: 'Correct the ambiguous bot mention before sending.',
  groupMentionUnavailable: 'Correct the unavailable or ambiguous bot mention before sending.',
  groupReplierNotMember: 'Choose a current room member in Room replies.',
  groupMailNeverStarted: 'This mail never started a turn.',
  groupRemoteUnreachable: "Couldn't reach {{host}}. {{detail}}",
  groupRemoteUnreachableRetry: "Couldn't reach {{host}}. {{detail}} Post again to retry.",
  attachmentUnreadable: "{{name}} can't be read.",
  attachmentTooLarge: '{{name}} is over {{maxMb}} MB.',
  attachmentUploading: '{{name}} is still uploading.',
  attachmentExpired: '{{names}}: this attachment expired. Attach it again.',
  commentImagesTooMany: 'Comments take up to {{max}} images.',
  commentImagesTooLarge:
    'These images add up to {{totalMb}} MB. A comment takes up to {{maxMb}} MB.',
  commentImageNotStored: 'Only pasted or attached images can go on a comment.',
  commentAttachmentsUnavailable:
    "This computer can't take attachments right now. Comment again in a moment.",
  commentFileNotAbsolute: '{{path}}: name the file by its full path.',
  commentFilesTooMany: 'Comments take up to {{max}} files besides images.',
  commentChatDeleted: "This item's chat was deleted, so files can't be attached here.",
  commentAttachFailed: "Couldn't attach the files. Comment again in a moment.",
  groupImagesTooMany: 'Group messages take up to {{max}} images.',
  groupImagesTooLarge:
    'These images add up to {{totalMb}} MB. A group message takes up to {{maxMb}} MB.',
  groupImageNotStored: 'Only pasted or attached images can go in a group message.',
  groupAttachmentsUnavailable:
    "This computer can't take attachments right now. Try sending again in a moment.",
  groupAttachFailed: "Couldn't attach the files. Try sending again in a moment."
} as const

export type BotFailureCode = keyof typeof BOT_FAILURE_COPY

export type BotFailureParams = Record<string, string | number>

/** A failure by code, as main sends it next to its English. */
export type BotFailure = { code: BotFailureCode; params?: BotFailureParams }

const SLOT = /\{\{(\w+)\}\}/g

export function isBotFailureCode(value: unknown): value is BotFailureCode {
  return typeof value === 'string' && Object.hasOwn(BOT_FAILURE_COPY, value)
}

export const BOT_FAILURE_CODES: BotFailureCode[] =
  Object.keys(BOT_FAILURE_COPY).filter(isBotFailureCode)

/** The English main shows and the CLI prints; one pass, so a value holding "{{x}}" stays verbatim. */
export function botFailureEnglish(failure: BotFailure): string {
  const params = failure.params ?? {}
  return BOT_FAILURE_COPY[failure.code].replace(SLOT, (slot, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : slot
  )
}

export function botFailure(code: BotFailureCode, params?: BotFailureParams): BotFailure {
  return params && Object.keys(params).length > 0 ? { code, params } : { code }
}

/** The English of each failure in `table`, for main code that passes failures as text. */
export function botFailureEnglishTable<K extends string>(
  table: Record<K, BotFailure>
): Record<K, string> {
  const english: Partial<Record<K, string>> = {}
  for (const name in table) {
    english[name] = botFailureEnglish(table[name])
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the loop filled every key of `table`.
  return english as Record<K, string>
}

/** Thrown in main; RPC sends its English as the message and its code in `data.botFailure`. */
export class BotFailureError extends Error {
  readonly data: { botFailure: BotFailure }

  constructor(code: BotFailureCode, params?: BotFailureParams) {
    const failure = botFailure(code, params)
    super(botFailureEnglish(failure))
    this.name = 'BotFailureError'
    this.data = { botFailure: failure }
  }
}

/** A failure from the wire, or null when its code is unknown here or a slot's value is missing. */
export function readBotFailure(value: unknown): BotFailure | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const code: unknown = 'code' in value ? value.code : undefined
  const params: unknown = 'params' in value ? value.params : undefined
  if (!isBotFailureCode(code)) {
    return null
  }
  const values: BotFailureParams = {}
  if (typeof params === 'object' && params !== null) {
    for (const [name, entry] of Object.entries(params)) {
      if (typeof entry === 'string' || (typeof entry === 'number' && Number.isFinite(entry))) {
        values[name] = entry
      }
    }
  }
  const template = BOT_FAILURE_COPY[code]
  const filled = [...template.matchAll(SLOT)].every(([, name]) => Object.hasOwn(values, name))
  return filled ? botFailure(code, values) : null
}

/** A failure in the reader's language; English is the catalog's fallback. */
export function botFailureText(failure: BotFailure, t: BotChatTranslate): string {
  return t(`bots.failures.${failure.code}`, BOT_FAILURE_COPY[failure.code], failure.params)
}

/** A status line main sent as English with an optional code: translated when the code is known. */
export function botCodedText(english: string, failure: unknown, t: BotChatTranslate): string {
  const known = readBotFailure(failure)
  return known ? botFailureText(known, t) : english
}
