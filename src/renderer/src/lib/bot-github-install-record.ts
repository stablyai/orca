// The one "Add <bot> to GitHub" in progress: which bot, whether it shows as the dialog or the pill, and
// what the owner had before going to GitHub's page. The dialog and the pill both render from it, so
// minimizing closes the dialog for real; a wait still pending survives a restart.
import { useSyncExternalStore } from 'react'
import {
  type ConnectorGitHubInstallation,
  GITHUB_LOGIN_PATTERN
} from '../../../shared/connector-bot-github-contract'
import type { BotRef } from './bot-hosts'
import type { ExecutionHostId } from '../../../shared/execution-host/execution-host'
import {
  awaitGitHubChange,
  type AwaitGitHubOptions,
  type BotGitHubView,
  type GitHubWait,
  isGitHubWaitRunning,
  readBotGitHub,
  readGitHubAwait,
  refreshBotGitHub,
  stopAwaitingGitHub,
  subscribeBotGitHub
} from './bot-github-state'
import type { HttpLinkDestination } from './browser/navigation/http-link-routing'
import { cancelConnectorConnect, startConnectorConnect } from './connector-connect-state'

export type GitHubInstallRecord = {
  bot: BotRef
  /** For the pill, before the bot list has loaded. */
  botName: string
  surface: 'dialog' | 'pill'
  /** The bot was on GitHub when setup opened, so the dialog keeps that title. */
  wasOn: boolean
  turnedOn: boolean
  /** The installs before the last trip to GitHub's install page; null before any trip. */
  before: ConnectorGitHubInstallation[] | null
  /** The last trip opened in the system browser. */
  inSystemBrowser: boolean
  /** Following GitHub until the installs change. */
  waiting: boolean
}

// Every 3 s for 2 minutes, then every 30 s; at once, then every 1 s for a while, when the owner comes
// back from GitHub (see followProviderReturn).
export const GITHUB_INSTALL_FOLLOW: AwaitGitHubOptions = { slowAfterMs: 2 * 60_000 }
const STORAGE_KEY = 'orca.bots.githubInstall.v1'

let record: GitHubInstallRecord | null = null
let wait: GitHubWait | null = null
let stopWatchingWait: (() => void) | null = null
const listeners = new Set<() => void>()

function save(next: GitHubInstallRecord | null): void {
  record = next
  try {
    // Only a pending wait is worth bringing back after a restart.
    if (next?.waiting) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    } else {
      localStorage.removeItem(STORAGE_KEY)
    }
  } catch {
    // Storage full or unavailable: the record still lives for this session.
  }
  listeners.forEach((listener) => listener())
}

function update(fields: Partial<GitHubInstallRecord>): void {
  if (record) {
    save({ ...record, ...fields })
  }
}

export function readGitHubInstallRecord(): GitHubInstallRecord | null {
  return record
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useGitHubInstallRecord(): GitHubInstallRecord | null {
  return useSyncExternalStore(subscribe, readGitHubInstallRecord)
}

// After a wait stops without GitHub saving: soon, or slower when the last read failed (offline).
const REFOLLOW_MS = 3_000
const REFOLLOW_AFTER_ERROR_MS = 30_000
let refollowTimer: ReturnType<typeof setTimeout> | undefined

function endWait(): void {
  clearTimeout(refollowTimer)
  refollowTimer = undefined
  stopWatchingWait?.()
  stopWatchingWait = null
  if (record) {
    stopAwaitingGitHub(record.bot.hostId, wait)
  }
  wait = null
}

function startWait(): void {
  refollowTimer = undefined
  if (record) {
    own(awaitGitHubChange(record.bot.hostId, Number.POSITIVE_INFINITY, GITHUB_INSTALL_FOLLOW))
  }
}

/** Only GitHub saving ends the record's waiting (or Close, ✕ and Turn on). A wait that stops for
 *  anything else (a failed read, the Orca account signing in after a restart) is followed again. */
function onGitHubRead(): void {
  if (!record?.waiting) {
    return
  }
  const { hostId } = record.bot
  const view = readBotGitHub(hostId)
  if (record.before === null && view.status === 'ready') {
    update({ before: view.github.installations })
    return
  }
  if (gitHubInstallChanged(record, view)) {
    endWait()
    update({ waiting: false })
    return
  }
  // Another surface's wait reads for us meanwhile; ours follows again once it ends.
  if (
    isGitHubWaitRunning(hostId, wait) ||
    readGitHubAwait(hostId) === 'checking' ||
    refollowTimer
  ) {
    return
  }
  refollowTimer = setTimeout(
    startWait,
    view.status === 'failed' ? REFOLLOW_AFTER_ERROR_MS : REFOLLOW_MS
  )
}

/** This record's wait from now on; the record keeps waiting until GitHub saves. */
function own(next: GitHubWait): void {
  clearTimeout(refollowTimer)
  refollowTimer = undefined
  wait = next
  update({ waiting: true })
  stopWatchingWait ??= subscribeBotGitHub(onGitHubRead)
}

/** Follows GitHub for this setup unless it already is. */
export function followGitHubInstall(): void {
  if (record && !isGitHubWaitRunning(record.bot.hostId, wait)) {
    startWait()
  }
}

/** Opens (or brings back) the setup dialog for `bot`; another bot's setup in progress ends. */
export function openGitHubInstall(bot: BotRef & { name: string; github: unknown }): void {
  if (record && record.bot.id === bot.id && record.bot.hostId === bot.hostId) {
    update({ surface: 'dialog', botName: bot.name })
    return
  }
  closeGitHubInstall()
  save({
    bot: { hostId: bot.hostId, id: bot.id },
    botName: bot.name,
    surface: 'dialog',
    wasOn: bot.github !== null,
    turnedOn: false,
    before: null,
    inSystemBrowser: false,
    waiting: false
  })
}

/** Links another GitHub login, or reads again what one reaches (Refresh): the setup's own sign-in,
 *  with GitHub's account picker. One already on GitHub ends on Done, since the login's installations
 *  just join its rows. */
export function addGitHubAccount(bot: BotRef & { name: string; github: unknown }): void {
  signInToGitHub(bot, {})
}

/** More GitHub access for a bot already on GitHub (Add org): the same sign-in, then GitHub's install
 *  page only if the login picked can't reach `workspace`, or none is named. `onOlderHost`: the host
 *  can't, so the setup closes for the install page alone. */
export function addGitHubAccess(
  bot: BotRef & { name: string; github: unknown },
  workspace: string | undefined,
  onOlderHost: () => void
): void {
  signInToGitHub(bot, {
    addAccess: workspace && GITHUB_LOGIN_PATTERN.test(workspace) ? { workspace } : {},
    onOlderHost: () => {
      closeGitHubInstall()
      onOlderHost()
    }
  })
}

function signInToGitHub(
  bot: BotRef & { name: string; github: unknown },
  options: Pick<Parameters<typeof startConnectorConnect>[2] & object, 'addAccess' | 'onOlderHost'>
): void {
  openGitHubInstall(bot)
  update({ turnedOn: bot.github !== null })
  void startConnectorConnect(bot.hostId, 'github', {
    ...options,
    switchAccount: true,
    bot,
    owner: gitHubSetupOwner(bot),
    onOpened: (destination) => {
      if (destination === 'orca-browser') {
        minimizeGitHubInstall()
      }
    }
  })
}

/** The setup's own sign-in trips, so only those carry it on (useResumeAfterConnect). */
export function gitHubSetupOwner(bot: BotRef): string {
  return `github-setup:${bot.hostId}:${bot.id}`
}

export function minimizeGitHubInstall(): void {
  update({ surface: 'pill' })
}

export function expandGitHubInstall(): void {
  update({ surface: 'dialog' })
}

/** A trip to GitHub's install page: in Orca's browser the dialog minimizes so the page is free. */
export function tripToGitHubInstall(
  destinationHost: ExecutionHostId,
  destination: HttpLinkDestination,
  started: GitHubWait,
  before: ConnectorGitHubInstallation[] | undefined
): void {
  if (!record) {
    stopAwaitingGitHub(destinationHost, started)
    return
  }
  update({
    before: before ?? record.before ?? [],
    inSystemBrowser: destination === 'system-browser',
    ...(destination === 'orca-browser' ? { surface: 'pill' as const } : {})
  })
  own(started)
}

export function markGitHubTurnedOn(): void {
  endWait()
  update({ turnedOn: true, waiting: false })
}

/** Close, ✕ or Done: stops following GitHub and forgets the setup. */
export function closeGitHubInstall(): void {
  if (!record) {
    return
  }
  endWait()
  cancelConnectorConnect(record.bot.hostId, 'github')
  save(null)
}

function installsShape(installations: readonly ConnectorGitHubInstallation[]): string {
  return JSON.stringify(
    installations.map((installation) => [
      installation.installationId,
      installation.repositories?.map((repository) => repository.fullName).sort() ?? null
    ])
  )
}

/** Whether the installs differ from those before the trip: GitHub reported the owner's save. */
export function gitHubInstallChanged(current: GitHubInstallRecord, view: BotGitHubView): boolean {
  return (
    current.before !== null &&
    view.status === 'ready' &&
    installsShape(current.before) !== installsShape(view.github.installations)
  )
}

let resumed = false

/** A saved record from this version, still waiting; anything else is dropped. */
function isPendingRecord(value: unknown): value is GitHubInstallRecord {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const saved: Partial<Record<keyof GitHubInstallRecord, unknown>> = value
  return (
    saved.waiting === true &&
    typeof saved.botName === 'string' &&
    typeof saved.bot === 'object' &&
    saved.bot !== null &&
    (saved.before === null || Array.isArray(saved.before))
  )
}

/** After a restart: a wait still pending comes back as the pill, and reads GitHub first. */
export function resumeGitHubInstall(): void {
  if (resumed) {
    return
  }
  resumed = true
  let saved: unknown = null
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')
  } catch {
    saved = null
  }
  if (!isPendingRecord(saved) || record) {
    return
  }
  save({ ...saved, surface: 'pill' })
  const hostId = saved.bot.hostId
  void refreshBotGitHub(hostId).then(() => {
    if (!record) {
      return
    }
    if (gitHubInstallChanged(record, readBotGitHub(hostId))) {
      update({ waiting: false })
    } else {
      followGitHubInstall()
    }
  })
}

/** Tests only: forget everything this module holds. */
export function resetGitHubInstallForTests(): void {
  endWait()
  record = null
  resumed = false
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Nothing saved.
  }
}
