// Bot access wording (Who can ask, Request access), in English: the desktop's translate fallbacks and the phone's text.

export const BOT_ACCESS_COPY = {
  titleOne: 'Give {{person}} access to {{name}}?',
  titleMany: 'Give {{count}} people access to {{name}}?',
  place: '{{connector}} ({{workspace}})',
  // The desktop confirm: one warning line, then up to four one-line rows of what they reach.
  confirmWarning: 'They’ll act as you on {{computer}}.',
  // The phone's heading over those rows.
  whatTheyCanDo: 'What {{person}} can do',
  confirmComputer: 'Run commands and change files',
  confirmNoApprovals: 'Acts without asking first',
  confirmMaySkipApprovals: 'May act without asking first',
  confirmApproveOne: '{{person}} can approve its prompts',
  confirmApproveMany: 'They can approve its prompts',
  confirmGoogle: 'Use your Google account',
  confirmGitHub: 'Comment and push on GitHub as you',
  confirmLinear: 'Update Linear issues as you',
  // The phone's confirm, which words the grant in full; the desktop shows the lines above.
  descriptionOne:
    '{{person}} will be able to ask {{name}} from {{place}} and, through it, work on {{computer}} as you: run commands, open and change files, use your connected accounts, and approve its requests.',
  account: 'Their {{connector}} account: {{identity}}',
  yourAccess:
    'Their requests use your access, not their own. Anything {{name}} can do {{there}}, they can ask it to do.',
  removeAnyTime: 'You can remove them from Who can ask at any time.',
  // {{computer}} for the desktop, which is the computer the bot runs on.
  thisComputer: 'this computer',
  here: 'here',
  thisServer: 'this server',
  executionComputer: 'the computer this agent runs on',
  there: 'there',
  confirm: 'Give access',
  // The confirm's dismiss button when it answers a request: it declines, unlike Escape.
  reject: 'Reject',
  heading: 'Asking for access',
  decline: 'Decline',
  review: 'Review…',
  full: 'Remove someone before adding {{person}}.',
  decideFailed: 'Couldn’t save your answer. Try again.',
  // Who can ask: one summary, then what they reach, then advice. See bot-access-reach.ts.
  whoCanAsk: 'Who can ask {{name}}',
  summaryOnlyYou: 'Only you can ask {{name}}.',
  summaryOne: 'You and {{person}} can ask {{name}}.',
  summarySome: 'You, {{people}} and {{last}} can ask {{name}}.',
  summaryMany: 'You and {{count}} other people can ask {{name}}.',
  controlNone:
    'Anyone you add can use {{name}} to work on {{computer}} as you: run commands, open and change files, and use your connected accounts.',
  controlOne:
    '{{person}} can use {{name}} to work on {{computer}} as you: run commands, open and change files, and use your connected accounts.',
  controlMany:
    'They can use {{name}} to work on {{computer}} as you: run commands, open and change files, and use your connected accounts.',
  // A connector's own page: the warning under its Who can ask, in one line.
  controlBrief: 'They can act as you here.',
  controlBriefIfAdded: 'Anyone you add can act as you here.',
  controlBriefOnHost: 'They can act as you on {{computer}}.',
  controlBriefIfAddedOnHost: 'Anyone you add can act as you on {{computer}}.',
  reachHeading: 'What {{name}} can reach',
  reachComputer: 'Your files, commands and accounts on {{computer}}',
  reachComputerDetail: 'As you, as far as the permission below allows.',
  reachPermission: 'New conversations start in {{mode}}',
  reachPermissionUnknown: 'New conversations start from your chat permission setting',
  permissionFellBack: '{{agent}} has no {{mode}} mode, so {{name}} uses Ask for approval.',
  codexAsk: 'Codex sandbox: read-only until a request is approved.',
  codexOwnSandbox: 'Codex uses its configured sandbox.',
  codexNoSandbox: 'No Codex sandbox.',
  whoeverAskedApproves: 'If it asks, whoever asked can approve.',
  reachLinear: 'Comment on, update and create Linear issues as you',
  reachSlack: 'Post in Slack as @{{name}}',
  reachGitHub: 'Comment, review and push on GitHub as you',
  reachGoogleEmail: 'Read and send your email',
  reachGoogleCalendar: 'Use your calendar',
  reachGoogleDrive: 'Use your Drive files',
  reachGoogleDocs: 'Read and edit your Docs',
  reachGoogleSheets: 'Read and edit your Sheets',
  reachGoogleUnknown: 'Your Google account, as far as you allowed it when you signed in',
  trust: 'Add only people you’d trust at your keyboard.',
  adviceHeading: 'Before you share',
  fixOnlyMe: 'Keep {{name}} to yourself',
  fixOnlyMeDetail: 'Removes the people you added here.',
  fixOnlyMeAction: 'Keep only me',
  fixGoogle: 'Turn off Google for {{name}}',
  fixGoogleDetail: 'For everyone, you included, from its next Google request.',
  fixGoogleAction: 'Turn off',
  fixGoogleDone: 'Google is off for {{name}}.',
  fixAsk: 'Start new conversations in Ask for approval',
  fixAskDetail:
    '{{name}} asks before more of its work. Whoever asked can still approve. Conversations already open keep their permission.',
  fixAskDetailCodex:
    'Codex then works read-only until a request is approved. Whoever asked can still approve. Conversations already open keep their permission.',
  fixAskAction: 'Switch',
  // The phone confirms each fix, since it has no Undo.
  fixOnlyMeConfirm: 'Keep {{name}} to yourself?',
  fixOnlyMeConfirmDetail:
    '{{people}} can no longer ask {{name}}. Giving them access again asks you first.',
  fixAskConfirm: 'Start new conversations in Ask for approval?',
  fixOnlyMeFailed: 'Couldn’t remove {{names}}. Try again.',
  fixAskDone: 'New conversations start in Ask for approval.',
  undo: 'Undo',
  separateBot:
    'A separate bot for the team gets its own permission, Google switch and tools. It still runs on {{computer}} as you.',
  newBot: 'New bot…'
} as const

export type BotAccessCopyId = keyof typeof BOT_ACCESS_COPY

/** {{computer}} and {{there}} on a phone, which is not the computer the bot runs on. */
export const BOT_ACCESS_FROM_PHONE = { computer: 'your computer', there: 'there' } as const

/** Name the execution host from the reader's device. */
export type BotAccessHost =
  | { kind: 'this-computer' }
  | { kind: 'server'; name: string | null }
  | { kind: 'owner-computer' }
  | { kind: 'unknown'; name: string | null }

type PlaceWordId = 'thisComputer' | 'here' | 'thisServer' | 'there' | 'executionComputer'

/** {{computer}} and {{there}} for `host`; `word` translates on the desktop. */
export function botAccessPlace(
  host: BotAccessHost,
  word: (id: PlaceWordId) => string = (id) => BOT_ACCESS_COPY[id]
): { computer: string; there: string } {
  switch (host.kind) {
    case 'this-computer':
      return { computer: word('thisComputer'), there: word('here') }
    case 'server':
      return { computer: host.name?.trim() || word('thisServer'), there: word('there') }
    case 'owner-computer':
      return BOT_ACCESS_FROM_PHONE
    case 'unknown':
      return { computer: host.name?.trim() || word('executionComputer'), there: word('there') }
  }
}

/** The English text with its {{placeholders}} filled, for a side without translation. */
export function botAccessCopy(
  id: BotAccessCopyId,
  values: Record<string, string | number> = {}
): string {
  return BOT_ACCESS_COPY[id].replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
    name in values ? String(values[name]) : match
  )
}
