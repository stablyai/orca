import { createHash } from 'node:crypto'
import {
  canonicalizeCapability,
  PLUGIN_CAPABILITY_DESCRIPTIONS,
  type PluginCapability
} from '../capabilities/plugin-capabilities'
import {
  pluginContributionSummary,
  type PluginContributionSummaryItem
} from '../contributions/plugin-contribution-summary'
import {
  pluginExecutionProfile,
  type PluginExecutionProfile
} from '../contributions/plugin-execution-profile'
import type { PluginManifest } from '../manifest/plugin-manifest'

/** CLI approvals: an explicit `--approve <fingerprint>` bound to the exact bytes and access shown. */

export const PLUGIN_APPROVAL_REQUIRED_CODE = 'approval_required'
export const PLUGIN_APPROVAL_STALE_CODE = 'approval_stale'
export const PLUGIN_NOT_FOUND_CODE = 'plugin_not_found'
export const PLUGIN_INVALID_CODE = 'plugin_invalid'
export const PLUGIN_SYSTEM_DISABLED_CODE = 'plugin_system_disabled'
/** Codes the runtime passes through to CLI callers with their `data`. */
export const PLUGIN_CLI_ERROR_CODES = [
  PLUGIN_APPROVAL_REQUIRED_CODE,
  PLUGIN_APPROVAL_STALE_CODE,
  PLUGIN_NOT_FOUND_CODE,
  PLUGIN_INVALID_CODE,
  PLUGIN_SYSTEM_DISABLED_CODE
] as const

/** A plugin CLI refusal whose `data` carries `nextSteps` for the caller. */
export class PluginCliError extends Error {
  readonly code: string
  readonly data: { nextSteps: string[] } & Record<string, unknown>

  constructor(
    code: string,
    message: string,
    data: { nextSteps: string[] } & Record<string, unknown>
  ) {
    super(message)
    this.name = 'PluginCliError'
    this.code = code
    this.data = data
  }
}

/** What the caller was doing; install and update reuse the same flag in later commands. */
export type PluginApprovalAction = 'enable' | 'dev-load' | 'install' | 'update'

export type PluginApprovalGrants = {
  execution: PluginExecutionProfile
  executionDescription: string
  capabilities: { kind: string; description: string }[]
  contributions: PluginContributionSummaryItem[]
}

export type PluginApprovalRequest = {
  pluginKey: string
  name: string
  version: string
  action: PluginApprovalAction
  approvalFingerprint: string
  /** Install tree hash, or the development folder's reviewed-content identity. */
  contentIdentity: string
  isDev: boolean
  grants: PluginApprovalGrants
  why: string
  /** The flag to add when re-running the same command. */
  approveFlag: string
  nextSteps: string[]
}

type ApprovalSubject = {
  pluginKey: string
  manifest: PluginManifest
  consentFingerprint: string
  contentIdentity: string
  isDev: boolean
}

const EXECUTION_DESCRIPTIONS: Record<PluginExecutionProfile, string> = {
  data: 'Content only (themes, icons, syntaxes, translations); nothing runs.',
  declarative:
    'Runs Orca actions you could run yourself through the commands, shortcuts or VM recipes it declares.',
  'sandboxed-ui':
    'Shows its own code in sandboxed panels or editors inside Orca; an editor reads every file it opens.',
  'trusted-worker':
    'Runs its own code in a separate Node.js process on the Orca host, with your user account’s access to that machine.'
}

/** Content-only plugins never need the flag; main decides this from the verified manifest. */
export function pluginNeedsCliApproval(manifest: PluginManifest): boolean {
  return pluginExecutionProfile(manifest) !== 'data'
}

export function pluginApprovalGrants(manifest: PluginManifest): PluginApprovalGrants {
  const execution = pluginExecutionProfile(manifest)
  return {
    execution,
    executionDescription: EXECUTION_DESCRIPTIONS[execution],
    capabilities: uniqueCapabilities(manifest.capabilities).map((capability) => ({
      kind: capability.kind,
      description: PLUGIN_CAPABILITY_DESCRIPTIONS[capability.kind]
    })),
    contributions: pluginContributionSummary(manifest)
  }
}

function uniqueCapabilities(capabilities: readonly PluginCapability[]): PluginCapability[] {
  const seen = new Set<string>()
  return capabilities.filter((capability) => {
    const key = canonicalizeCapability(capability)
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}

/** Binds key, version, content and every grant shown, so no other plugin, build or access reuses it. */
export function pluginApprovalFingerprint(subject: ApprovalSubject): string {
  const grants = pluginApprovalGrants(subject.manifest)
  const canonical = JSON.stringify([
    'orca-plugin-approval-v1',
    subject.pluginKey,
    subject.manifest.version,
    subject.consentFingerprint,
    subject.contentIdentity,
    grants.execution,
    uniqueCapabilities(subject.manifest.capabilities).map(canonicalizeCapability).sort(),
    grants.contributions.map((item) => [item.kind, item.name, item.detail ?? null])
  ])
  return `ap1-${createHash('sha256').update(canonical).digest('hex').slice(0, 32)}`
}

export function buildPluginApprovalRequest(
  subject: ApprovalSubject,
  action: PluginApprovalAction
): PluginApprovalRequest {
  const grants = pluginApprovalGrants(subject.manifest)
  const approvalFingerprint = pluginApprovalFingerprint(subject)
  const approveFlag = `--approve ${approvalFingerprint}`
  const devNote = subject.isDev
    ? ' Later code edits in this development folder run without asking again; new access, a higher execution level, or changed commands and shortcuts need a new approval.'
    : ''
  return {
    pluginKey: subject.pluginKey,
    name: subject.manifest.name,
    version: subject.manifest.version,
    action,
    approvalFingerprint,
    contentIdentity: subject.contentIdentity,
    isDev: subject.isDev,
    grants,
    why: `It can run code or act in Orca, so Orca does not enable it without an explicit approval bound to exactly these files and this access.${devNote}`,
    approveFlag,
    nextSteps: [
      'Approving grants the access listed above. Confirm with your user first unless they already asked for exactly this plugin and access.',
      `To approve, run the same command again with ${approveFlag}`,
      'A different plugin, version, set of files, or more access gets a new fingerprint and needs a new approval.'
    ]
  }
}

/** One message for humans; agents read `data` instead. */
export function formatPluginApprovalMessage(request: PluginApprovalRequest, stale = false): string {
  const lead = stale
    ? `That fingerprint does not match what ${request.pluginKey} would get now: the plugin changed since it was shown, or the fingerprint is for something else. Review the current grants.`
    : `${request.pluginKey} ${request.version} needs approval before it can run.`
  const lines = [
    lead,
    `Approving ${request.name} (${request.pluginKey} ${request.version}${request.isDev ? ', development folder' : ''}) grants:`,
    `- ${request.grants.executionDescription}`,
    ...request.grants.capabilities.map((capability) => `- ${capability.description}`)
  ]
  if (request.grants.contributions.length > 0) {
    lines.push(
      `Adds: ${request.grants.contributions.map((item) => `${item.kind} "${item.name}"`).join(', ')}`
    )
  }
  lines.push(
    `Why approval is needed: ${request.why}`,
    `Fingerprint: ${request.approvalFingerprint}`
  )
  return lines.join('\n')
}

export class PluginApprovalRequiredError extends Error {
  readonly code: string
  readonly data: PluginApprovalRequest

  constructor(request: PluginApprovalRequest, stale = false) {
    super(formatPluginApprovalMessage(request, stale))
    this.name = 'PluginApprovalRequiredError'
    this.code = stale ? PLUGIN_APPROVAL_STALE_CODE : PLUGIN_APPROVAL_REQUIRED_CODE
    this.data = request
  }
}

export class PluginNotFoundError extends Error {
  readonly code = PLUGIN_NOT_FOUND_CODE
  readonly data: { pluginKey: string; nextSteps: string[] }

  constructor(pluginKey: string) {
    super(`No valid plugin ${pluginKey} is loaded on this Orca host.`)
    this.name = 'PluginNotFoundError'
    this.data = {
      pluginKey,
      nextSteps: [
        'Check the plugin key, and that the plugin is installed or loaded on this Orca host.'
      ]
    }
  }
}
