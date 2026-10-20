// Pure module: imported by the renderer, the main process, and the relay.
import { P4_SUBMIT_TIMEOUT_MS, P4_SYNC_TIMEOUT_MS } from './perforce-timeouts'

export type PerforceGroupOrder = 'default-first' | 'numbered-first' | 'unopened-first'
export type PerforceCompareAgainst = 'have' | 'head'
export type PerforceSaveBehavior = 'ask' | 'auto' | 'never'
export type PerforceNewChangelistMode = 'move-selected' | 'empty'
export type PerforceShelfAfterSubmit = 'delete' | 'keep-copy'

export type PerforceSettings = {
  /** Absolute path to `p4`; empty means auto-detect. */
  p4Path: string
  /** Empty values fall back to the user's `p4 set` / P4CONFIG environment. */
  p4Port: string
  p4User: string
  p4Client: string
  p4Config: string
  useIgnoreFile: boolean
  ignoreFileName: string
  commandTimeoutSeconds: number
  statusScanTimeoutSeconds: number
  groupOrder: PerforceGroupOrder
  showModifiedNotOpened: boolean
  showNewFiles: boolean
  /** 0 turns background refresh off. */
  refreshIntervalSeconds: number
  compareAgainst: PerforceCompareAgainst
  saveReadOnlyBehavior: PerforceSaveBehavior
  showEditedTabPrefix: boolean
  newChangelistDescriptionTemplate: string
  newChangelistMode: PerforceNewChangelistMode
  confirmSubmit: boolean
  confirmShelvedOnlySubmit: boolean
  confirmDestructiveActions: boolean
  shelfAfterSubmit: PerforceShelfAfterSubmit
  aiDescriptionEnabled: boolean
  /** Empty means the app's default agent; otherwise an agent id or 'custom'. Independent of Git AI Author. */
  aiAgentId: string
  aiModel: string
  aiThinkingLevel: string
  aiCustomCommand: string
  aiAgentArgs: string
  /** Extra instructions appended to the description prompt. */
  aiInstructions: string
  /** Workspace copies: leave each Unity project's Library/PackageCache out (Unity refills it). */
  copySkipPackageCache: boolean
  /** Workspace copies: workspace-relative folders to leave out, one per line. */
  copyExcludedFolders: string
  /** Workspace copies: refuse to make one when the drive has less free space, in GB. */
  copyMinFreeSpaceGb: number
}

export const DEFAULT_PERFORCE_SETTINGS: PerforceSettings = {
  p4Path: '',
  p4Port: '',
  p4User: '',
  p4Client: '',
  p4Config: '',
  useIgnoreFile: false,
  ignoreFileName: '.p4ignore',
  commandTimeoutSeconds: 60,
  statusScanTimeoutSeconds: 180,
  groupOrder: 'default-first',
  showModifiedNotOpened: true,
  showNewFiles: true,
  refreshIntervalSeconds: 15,
  compareAgainst: 'have',
  saveReadOnlyBehavior: 'auto',
  showEditedTabPrefix: true,
  newChangelistDescriptionTemplate: '',
  newChangelistMode: 'move-selected',
  confirmSubmit: false,
  confirmShelvedOnlySubmit: true,
  confirmDestructiveActions: true,
  shelfAfterSubmit: 'delete',
  aiDescriptionEnabled: true,
  aiAgentId: '',
  aiModel: '',
  aiThinkingLevel: '',
  aiCustomCommand: '',
  aiAgentArgs: '',
  aiInstructions: '',
  copySkipPackageCache: false,
  copyExcludedFolders: '',
  copyMinFreeSpaceGb: 10
}

const MAX_TEXT_LENGTH = 4096

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value.trim().slice(0, MAX_TEXT_LENGTH) : fallback
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function choice<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.find((option) => option === value) ?? fallback
}

function bounded(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.round(value)))
    : fallback
}

/** Fills defaults and clamps every field; safe for any persisted or wire value. */
export function normalizePerforceSettings(value: unknown): PerforceSettings {
  const raw: Record<string, unknown> =
    typeof value === 'object' && value !== null ? { ...value } : {}
  const d = DEFAULT_PERFORCE_SETTINGS
  return {
    p4Path: text(raw.p4Path, d.p4Path),
    p4Port: text(raw.p4Port, d.p4Port),
    p4User: text(raw.p4User, d.p4User),
    p4Client: text(raw.p4Client, d.p4Client),
    p4Config: text(raw.p4Config, d.p4Config),
    useIgnoreFile: flag(raw.useIgnoreFile, d.useIgnoreFile),
    ignoreFileName: text(raw.ignoreFileName, d.ignoreFileName) || d.ignoreFileName,
    commandTimeoutSeconds: bounded(raw.commandTimeoutSeconds, d.commandTimeoutSeconds, 5, 3600),
    statusScanTimeoutSeconds: bounded(
      raw.statusScanTimeoutSeconds,
      d.statusScanTimeoutSeconds,
      10,
      3600
    ),
    groupOrder: choice(
      raw.groupOrder,
      ['default-first', 'numbered-first', 'unopened-first'],
      d.groupOrder
    ),
    showModifiedNotOpened: flag(raw.showModifiedNotOpened, d.showModifiedNotOpened),
    showNewFiles: flag(raw.showNewFiles, d.showNewFiles),
    refreshIntervalSeconds:
      raw.refreshIntervalSeconds === 0
        ? 0
        : bounded(raw.refreshIntervalSeconds, d.refreshIntervalSeconds, 5, 3600),
    compareAgainst: choice(raw.compareAgainst, ['have', 'head'], d.compareAgainst),
    saveReadOnlyBehavior: choice(
      raw.saveReadOnlyBehavior,
      ['ask', 'auto', 'never'],
      d.saveReadOnlyBehavior
    ),
    showEditedTabPrefix: flag(raw.showEditedTabPrefix, d.showEditedTabPrefix),
    newChangelistDescriptionTemplate:
      typeof raw.newChangelistDescriptionTemplate === 'string'
        ? raw.newChangelistDescriptionTemplate.slice(0, MAX_TEXT_LENGTH)
        : d.newChangelistDescriptionTemplate,
    newChangelistMode: choice(
      raw.newChangelistMode,
      ['move-selected', 'empty'],
      d.newChangelistMode
    ),
    confirmSubmit: flag(raw.confirmSubmit, d.confirmSubmit),
    confirmShelvedOnlySubmit: flag(raw.confirmShelvedOnlySubmit, d.confirmShelvedOnlySubmit),
    confirmDestructiveActions: flag(raw.confirmDestructiveActions, d.confirmDestructiveActions),
    shelfAfterSubmit: choice(raw.shelfAfterSubmit, ['delete', 'keep-copy'], d.shelfAfterSubmit),
    aiDescriptionEnabled: flag(raw.aiDescriptionEnabled, d.aiDescriptionEnabled),
    aiAgentId: text(raw.aiAgentId, d.aiAgentId),
    aiModel: text(raw.aiModel, d.aiModel),
    aiThinkingLevel: text(raw.aiThinkingLevel, d.aiThinkingLevel),
    aiCustomCommand: text(raw.aiCustomCommand, d.aiCustomCommand),
    aiAgentArgs: text(raw.aiAgentArgs, d.aiAgentArgs),
    aiInstructions:
      typeof raw.aiInstructions === 'string'
        ? raw.aiInstructions.slice(0, MAX_TEXT_LENGTH * 4)
        : d.aiInstructions,
    copySkipPackageCache: flag(raw.copySkipPackageCache, d.copySkipPackageCache),
    copyExcludedFolders: text(raw.copyExcludedFolders, d.copyExcludedFolders),
    copyMinFreeSpaceGb: bounded(raw.copyMinFreeSpaceGb, d.copyMinFreeSpaceGb, 0, 4096)
  }
}

/**
 * The settings an SSH host may apply. The p4 path, client and P4CONFIG name things on this
 * computer, so the host finds its own `p4` and workspace instead of failing on ours.
 */
export function perforceSettingsForRemoteHost(settings: PerforceSettings): PerforceSettings {
  return { ...settings, p4Path: '', p4Client: '', p4Config: '' }
}

/**
 * What an Orca server applies to a client's request: the client's settings, with the p4 path,
 * client and P4CONFIG from the server's own Settings > Perforce, and the server's P4PORT and P4USER
 * where the client leaves them empty. A client that sends none (mobile, an older desktop) gets the
 * server's settings unchanged.
 */
export function perforceSettingsOnHost(
  clientSettings: unknown,
  hostSettings: PerforceSettings
): PerforceSettings {
  if (clientSettings === undefined || clientSettings === null) {
    return hostSettings
  }
  const client = normalizePerforceSettings(clientSettings)
  const { p4Path, p4Client, p4Config } = hostSettings
  return {
    ...client,
    p4Path,
    p4Client,
    p4Config,
    p4Port: client.p4Port || hostSettings.p4Port,
    p4User: client.p4User || hostSettings.p4User
  }
}

/**
 * How long a transport (SSH relay, Orca server) waits for Perforce operation `operation`. p4 stops
 * each command at its own limit, so this outlasts that limit: a status scan plus one command, or
 * p4's longer limit for submit and sync.
 */
export function perforceRequestTimeoutMs(settings: PerforceSettings, operation: string): number {
  const p4Limit =
    operation === 'sync' ? P4_SYNC_TIMEOUT_MS : operation === 'submit' ? P4_SUBMIT_TIMEOUT_MS : 0
  const scanAndCommand = (settings.statusScanTimeoutSeconds + settings.commandTimeoutSeconds) * 1000
  return Math.max(p4Limit, scanAndCommand) + 30_000
}

/** The copy-excluded folders setting as a list (one per line or comma-separated). */
export function copyExcludedFolderList(settings: PerforceSettings): string[] {
  return settings.copyExcludedFolders
    .split(/[\r\n,]+/)
    .map((folder) => folder.trim())
    .filter(Boolean)
}

/** Section order for the Source Control panel; each id appears exactly once. */
export type PerforcePanelSection = 'default' | 'numbered' | 'modified' | 'new'

export function perforceSectionOrder(order: PerforceGroupOrder): PerforcePanelSection[] {
  switch (order) {
    case 'numbered-first':
      return ['numbered', 'default', 'modified', 'new']
    case 'unopened-first':
      return ['modified', 'new', 'default', 'numbered']
    case 'default-first':
      return ['default', 'numbered', 'modified', 'new']
  }
}

/** Environment p4 receives on top of the process environment. */
export function perforceEnvOverrides(settings: PerforceSettings): Record<string, string> {
  const env: Record<string, string> = {}
  if (settings.p4Port) {
    env.P4PORT = settings.p4Port
  }
  if (settings.p4User) {
    env.P4USER = settings.p4User
  }
  if (settings.p4Client) {
    env.P4CLIENT = settings.p4Client
  }
  if (settings.p4Config) {
    env.P4CONFIG = settings.p4Config
  }
  if (settings.useIgnoreFile) {
    env.P4IGNORE = settings.ignoreFileName
  }
  return env
}

/** Applies the description template, substituting `{user}` and `{client}` when known. */
export function applyChangelistTemplate(
  template: string,
  values: { user?: string; client?: string }
): string {
  return template
    .replaceAll('{user}', values.user ?? '')
    .replaceAll('{client}', values.client ?? '')
}
