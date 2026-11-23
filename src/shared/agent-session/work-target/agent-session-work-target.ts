import * as z from 'zod'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../execution-host/execution-host'

const MAX_WORK_TARGET_ID_LENGTH = 512
const MAX_WORK_TARGET_LABEL_LENGTH = 160

// Reject control characters and line breaks so IDs stay single-line and safe in structured context.
function hasControlChar(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) {
      return true
    }
  }
  return false
}

function stripControlChars(value: string): string {
  let out = ''
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    out += code <= 0x1f || code === 0x7f ? ' ' : value[index]
  }
  return out
}

export type AgentJournalWorkTarget = {
  kind: 'project' | 'workspace'
  /** Execution host owning the target (`local`, `ssh:<id>`, or `runtime:<environmentId>`). */
  hostId: string
  projectId?: string
  repoId?: string
  repoKind?: 'git' | 'folder'
  /** Git worktree ID, managed folder-repo worktree ID, or `folder:<folderWorkspaceId>`. */
  workspaceId?: string
  /** Durable occupant ID of a Git worktree so delete/recreate at the same path cannot match. */
  workspaceInstanceId?: string
  workspaceKind?: 'git-worktree' | 'folder'
  displayName: string
  projectName?: string
  hostLabel?: string
}

const SafeWorkTargetId = z
  .string()
  .min(1)
  .max(MAX_WORK_TARGET_ID_LENGTH)
  .refine((value) => !hasControlChar(value), 'Work target ID contains control characters')

const WorkTargetLabel = z.string().min(1).max(MAX_WORK_TARGET_LABEL_LENGTH)

/** Strict wire schema accepted on `agentSession.send`. */
export const SendWorkTarget = z
  .object({
    kind: z.enum(['project', 'workspace']),
    hostId: SafeWorkTargetId.refine(
      (value) => parseExecutionHostId(value) !== null,
      'Invalid execution host ID'
    ),
    projectId: SafeWorkTargetId.optional(),
    repoId: SafeWorkTargetId.optional(),
    repoKind: z.enum(['git', 'folder']).optional(),
    workspaceId: SafeWorkTargetId.optional(),
    workspaceInstanceId: SafeWorkTargetId.optional(),
    workspaceKind: z.enum(['git-worktree', 'folder']).optional(),
    displayName: WorkTargetLabel,
    projectName: WorkTargetLabel.optional(),
    hostLabel: WorkTargetLabel.optional()
  })
  .strict()
  .refine(
    (value) =>
      value.kind === 'project'
        ? Boolean(value.repoId || value.projectId)
        : Boolean(value.workspaceId),
    'Project targets require repoId or projectId; workspace targets require workspaceId'
  )

/** Open replay schema so rows written by newer builds remain readable. */
export const JournalWorkTargetSchema = z.object({
  kind: z.enum(['project', 'workspace']),
  hostId: z.string().min(1),
  projectId: z.string().min(1).optional(),
  repoId: z.string().min(1).optional(),
  repoKind: z.enum(['git', 'folder']).optional(),
  workspaceId: z.string().min(1).optional(),
  workspaceInstanceId: z.string().min(1).optional(),
  workspaceKind: z.enum(['git-worktree', 'folder']).optional(),
  displayName: z.string().min(1),
  projectName: z.string().min(1).optional(),
  hostLabel: z.string().min(1).optional()
})

export function parseAgentJournalWorkTarget(value: unknown): AgentJournalWorkTarget | undefined {
  const parsed = SendWorkTarget.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

export function sameAgentJournalWorkTarget(
  left: AgentJournalWorkTarget | null | undefined,
  right: AgentJournalWorkTarget | null | undefined
): boolean {
  if (!left && !right) {
    return true
  }
  if (!left || !right) {
    return false
  }
  return (
    left.kind === right.kind &&
    left.hostId === right.hostId &&
    left.projectId === right.projectId &&
    left.repoId === right.repoId &&
    left.repoKind === right.repoKind &&
    left.workspaceId === right.workspaceId &&
    left.workspaceInstanceId === right.workspaceInstanceId &&
    left.workspaceKind === right.workspaceKind
  )
}

/** Host-validated, authoritative placement resolved from live catalog state. */
export type ResolvedBotWorkTargetPlacement = {
  /** `new-top-level` creates a workspace under the selected Git project; `existing` places into a live workspace. */
  mode: 'new-top-level' | 'existing'
  repoSelector?: string
  worktreeSelector?: string
  /** Execution host scope on this runtime's store (`local` or `ssh:<id>`), preserved through launch. */
  targetHostId?: ExecutionHostId
  /** Durable checkout occupant ID verified before launch so path reuse cannot silently match. */
  expectedWorkspaceInstanceId?: string
  /** Paired server environment ID when executing via `--on`; absent for host-local/SSH targets. */
  onEnvironmentId?: string
  /** Pairing revision verified during admission/handover; changed pairing refuses launch. */
  onExpectedPairingRevision?: number
  /** Peer fingerprint verified during admission/handover; changed peer refuses launch. */
  onExpectedPeerFingerprint?: string
  canonicalTarget: AgentJournalWorkTarget
}

/** Strip markup, brackets, quotes, backticks and control chars so labels cannot forge context instructions. */
export function sanitizeWorkTargetLabel(text: string): string {
  return stripControlChars(text)
    .replace(/[<>[\]`"]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
}

function shellQuoteSelector(value: string): string {
  return /^[A-Za-z0-9_.:/@-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`
}

/** Build the single-turn `<orca_context>` ride-along from host-verified immutable selectors only. */
export function formatBotWorkTargetContext(
  placement: ResolvedBotWorkTargetPlacement,
  cliCommand = 'orca'
): string {
  const target = placement.canonicalTarget
  const label = sanitizeWorkTargetLabel(target.displayName)
  const parentProject =
    target.kind === 'workspace' && target.projectName
      ? ` in project "${sanitizeWorkTargetLabel(target.projectName)}"`
      : ''
  const hostSuffix =
    target.hostId !== LOCAL_EXECUTION_HOST_ID && target.hostLabel
      ? ` on host "${sanitizeWorkTargetLabel(target.hostLabel)}"`
      : ''
  const kindWord =
    target.kind === 'project'
      ? target.repoKind === 'folder'
        ? 'folder project'
        : 'project'
      : target.workspaceKind === 'folder'
        ? 'existing folder workspace'
        : 'existing workspace'

  const args: string[] = ['orchestration', 'worker-start']
  if (placement.onEnvironmentId) {
    args.push('--on', shellQuoteSelector(placement.onEnvironmentId))
  }
  if (placement.mode === 'new-top-level' && placement.repoSelector) {
    args.push('--repo', shellQuoteSelector(placement.repoSelector), '--worktree', 'new-top-level')
  } else if (placement.worktreeSelector) {
    args.push('--worktree', shellQuoteSelector(placement.worktreeSelector))
  }
  const command = `${cliCommand} ${args.join(' ')}`
  const placementRule =
    placement.mode === 'new-top-level'
      ? `When starting a worker for this request, target this exact project with \`${command}\` (creates a new workspace under that project, not under bot home).`
      : `When starting a worker for this request, target this exact existing workspace with \`${command}\` (do not create a new worktree or run in another project or bot home).`

  return [
    '<orca_context>',
    `User selected target ${kindWord} "${label}"${parentProject}${hostSuffix} for this message only.`,
    placementRule,
    'Do not route this request to another project, another host, or the bot home workspace.',
    '</orca_context>'
  ].join('\n')
}
