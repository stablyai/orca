// Who can ask a bot, what that lets them reach through it, and what to change before sharing it.
// One owner for every Who can ask surface (setup dialogs, connector rows, the phone); each side words it
// from BOT_ACCESS_COPY.
import {
  newChatPermissionMode,
  type AgentChatPermissionChoice,
  type AgentChatPermissionMode
} from '../agent-launch/permissions/agent-chat-permission-mode'
import { chatAsksNoApprovals } from '../agent-launch/permissions/agent-chat-permission-support'
import type { Bot } from '../bot-types'
import { botAccessCopy, type BotAccessCopyId } from './bot-access-copy'
import type { GoogleAccountView } from '../google/google-connect-types'
import type { GoogleService } from '../google/google-scopes'
import { finalSentenceStop, joinSentences } from '../text/sentence-joining'

/** The permission new bot conversations start in; null when this side can't know it (the agent's own
 *  settings, or an app default the phone can't read). */
export type BotStartingPermission = {
  mode: AgentChatPermissionMode | null
  /** The owner picked a mode this agent doesn't offer, so it starts in Ask (savedChatPermissionMode). */
  fellBackFrom: AgentChatPermissionMode | null
  /** The agent asks no approvals, so no other mode can be set. */
  fixed?: true
}

/** As bot-chat-session starts a conversation: the bot's own mode, else the app's new-chat choice. */
export function botStartingPermission(
  bot: { agent: string; permissionMode?: Bot['permissionMode'] },
  appDefault: AgentChatPermissionChoice | null
): BotStartingPermission {
  if (chatAsksNoApprovals(bot.agent)) {
    return { mode: 'full-access', fellBackFrom: null, fixed: true }
  }
  if (bot.permissionMode) {
    const mode = newChatPermissionMode(bot.agent, bot.permissionMode)
    const effective = mode === 'own' ? null : mode
    return {
      mode: effective,
      fellBackFrom:
        effective !== null && effective !== bot.permissionMode ? bot.permissionMode : null
    }
  }
  return { mode: appDefault === 'own' ? null : appDefault, fellBackFrom: null }
}

/** The lines under a permission, in order: the fallback, Codex's sandbox (only Codex sets one), the caveat. */
export function botPermissionNotes(
  agent: string,
  permission: BotStartingPermission
): BotAccessCopyId[] {
  const { mode } = permission
  const notes: BotAccessCopyId[] = []
  if (permission.fellBackFrom) {
    notes.push('permissionFellBack')
  }
  if (agent === 'codex' && mode) {
    notes.push(
      mode === 'full-access' ? 'codexNoSandbox' : mode === 'auto' ? 'codexOwnSandbox' : 'codexAsk'
    )
  }
  // Approvals are answered in the thread, by whoever asked (external-conversation-chat-prompts).
  if (mode !== 'full-access') {
    notes.push('whoeverAskedApproves')
  }
  return notes
}

export type BotAccessConnector = 'linear' | 'slack' | 'github'

export type BotReachLine =
  | { kind: 'computer' }
  | { kind: 'permission'; permission: BotStartingPermission; notes: BotAccessCopyId[] }
  | { kind: 'connector'; connector: BotAccessConnector }
  /** `area` null: Google is on, but this side can't read which services it allows. */
  | { kind: 'google'; area: GoogleReachArea | null }

export type GoogleReachArea = 'email' | 'calendar' | 'drive' | 'docs' | 'sheets'

const GOOGLE_AREAS: Partial<Record<GoogleService, GoogleReachArea>> = {
  gmail: 'email',
  calendar: 'calendar',
  drive: 'drive',
  docs: 'docs',
  sheets: 'sheets'
}

/** What a bot with Google on reaches: only services ready on a connected account, each on its own,
 *  since a sign-in picks them and each API reports its own readiness. */
export function googleReachAreas(
  accounts: readonly Pick<GoogleAccountView, 'status' | 'services'>[]
): GoogleReachArea[] {
  const ready = new Set(
    accounts
      .filter((account) => account.status === 'connected')
      .flatMap((account) =>
        account.services.filter((entry) => entry.state === 'ready').map((entry) => entry.service)
      )
      .map((service) => GOOGLE_AREAS[service])
  )
  return (['email', 'calendar', 'drive', 'docs', 'sheets'] as const).filter((area) =>
    ready.has(area)
  )
}

/** What anyone who can ask the bot reaches through it. `google`: the areas it reaches; [] for none;
 *  null when Google is on but this side can't tell which (the phone). */
export function botAccessReach(input: {
  agent: string
  permission: BotStartingPermission
  connector: BotAccessConnector | null
  google: readonly GoogleReachArea[] | null
}): BotReachLine[] {
  return [
    { kind: 'computer' },
    {
      kind: 'permission',
      permission: input.permission,
      notes: botPermissionNotes(input.agent, input.permission)
    },
    ...(input.connector ? [{ kind: 'connector' as const, connector: input.connector }] : []),
    ...(input.google === null
      ? [{ kind: 'google' as const, area: null }]
      : input.google.map((area) => ({ kind: 'google' as const, area })))
  ]
}

export const GOOGLE_REACH_COPY: Record<GoogleReachArea | 'unknown', BotAccessCopyId> = {
  email: 'reachGoogleEmail',
  calendar: 'reachGoogleCalendar',
  drive: 'reachGoogleDrive',
  docs: 'reachGoogleDocs',
  sheets: 'reachGoogleSheets',
  unknown: 'reachGoogleUnknown'
}

/** One reach line for a side that words it itself (the phone). `mode` words a permission mode as that
 *  side shows it; `copy` translates the table, English when absent. */
export function botReachLineText(
  line: BotReachLine,
  context: {
    name: string
    agentLabel: string
    place: { computer: string }
    mode: (mode: AgentChatPermissionMode) => { label: string; description: string }
    copy?: (id: BotAccessCopyId, values?: Record<string, string | number>) => string
  }
): { title: string; detail?: string } {
  const { name } = context
  const copy = context.copy ?? botAccessCopy
  switch (line.kind) {
    case 'computer':
      return {
        title: copy('reachComputer', context.place),
        detail: copy('reachComputerDetail')
      }
    case 'permission': {
      const { mode, fellBackFrom } = line.permission
      const notes = line.notes.map((id) =>
        copy(id, {
          name,
          agent: context.agentLabel,
          mode: fellBackFrom ? context.mode(fellBackFrom).label : ''
        })
      )
      if (!mode) {
        return { title: copy('reachPermissionUnknown'), detail: joinSentences(notes) }
      }
      const words = context.mode(mode)
      return {
        title: copy('reachPermission', { mode: words.label }),
        detail: joinSentences([
          `${words.description}${finalSentenceStop(words.description)}`,
          ...notes
        ])
      }
    }
    case 'connector':
      return { title: copy(CONNECTOR_REACH_COPY[line.connector], { name }) }
    case 'google':
      return { title: copy(GOOGLE_REACH_COPY[line.area ?? 'unknown']) }
  }
}

export const CONNECTOR_REACH_COPY: Record<BotAccessConnector, BotAccessCopyId> = {
  linear: 'reachLinear',
  slack: 'reachSlack',
  github: 'reachGitHub'
}

/** One line of the desktop's access confirm: shorter than a reach line, with no detail under it. */
export type BotAccessConfirmRow =
  | { kind: 'computer' }
  /** Full access: nothing waits for an approval. */
  | { kind: 'no-approvals' }
  /** A starting mode this side can't read: it may never ask. */
  | { kind: 'may-skip-approvals' }
  /** Ask or Auto: whoever asked answers its prompts. */
  | { kind: 'approves' }
  /** Google is on: one row for every area it reaches. */
  | { kind: 'google' }
  | { kind: 'connector'; connector: BotAccessConnector }

/** The access confirm's tone and rows, at most four. `high` (red) when the setup reaches far: Full
 *  access, a starting mode this side can't read (it may never ask), or Google; else `medium` (amber). */
export function botAccessConfirm(input: {
  permission: BotStartingPermission
  connector: BotAccessConnector
  google: boolean
}): { tone: 'high' | 'medium'; rows: BotAccessConfirmRow[] } {
  const { mode } = input.permission
  const tone = mode === 'full-access' || mode === null || input.google ? 'high' : 'medium'
  return {
    tone,
    rows: [
      { kind: 'computer' },
      {
        kind:
          mode === 'full-access'
            ? 'no-approvals'
            : mode === null
              ? 'may-skip-approvals'
              : 'approves'
      },
      ...(input.google ? [{ kind: 'google' as const }] : []),
      { kind: 'connector', connector: input.connector }
    ]
  }
}

export type BotAccessFix = 'only-me' | 'google-off' | 'ask-for-approval'

export type BotAccessAdvice = {
  /** Someone else can ask, and the setup reaches far: Full access, or Google on and signed in. */
  open: boolean
  fixes: BotAccessFix[]
}

/** Advice only once someone else can ask and the setup is open; Keep only me always comes first.
 *  `google`: Google reaches something through the bot (or may, where that can't be read). */
export function botAccessAdvice(input: {
  others: number
  permission: BotStartingPermission
  google: boolean
  /** The surface can turn Google off (the phone can't). */
  canTurnOffGoogle?: boolean
}): BotAccessAdvice {
  const { mode } = input.permission
  const open = input.others > 0 && (mode === 'full-access' || input.google)
  if (!open) {
    return { open, fixes: [] }
  }
  const fixes: BotAccessFix[] = ['only-me']
  if (input.google && input.canTurnOffGoogle !== false) {
    fixes.push('google-off')
  }
  // Unknown counts: a starting mode we can't read may never ask.
  if (!input.permission.fixed && (mode === null || mode === 'full-access' || mode === 'auto')) {
    fixes.push('ask-for-approval')
  }
  return { open, fixes }
}

type CopyLine = { id: BotAccessCopyId; values: Record<string, string | number> }

/** The summary's two lines, as copy ids and the names they fill. */
export function botAccessSummary(others: readonly string[]): { who: CopyLine; control: CopyLine } {
  if (others.length === 0) {
    return { who: { id: 'summaryOnlyYou', values: {} }, control: { id: 'controlNone', values: {} } }
  }
  const control: CopyLine =
    others.length === 1
      ? { id: 'controlOne', values: { person: others[0] } }
      : { id: 'controlMany', values: {} }
  if (others.length === 1) {
    return { who: { id: 'summaryOne', values: { person: others[0] } }, control }
  }
  if (others.length <= 3) {
    return {
      who: {
        id: 'summarySome',
        values: { people: others.slice(0, -1).join(', '), last: others.at(-1)! }
      },
      control
    }
  }
  return { who: { id: 'summaryMany', values: { count: others.length } }, control }
}
