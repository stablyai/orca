import { z } from 'zod'
import { WorktreeSelector } from './git-params'
import { OptionalTuiAgent } from './worktree-params'

// Shapes only: the host re-validates every path and changelist before it reaches a p4 argv.

/** The caller's Settings > Perforce; the host normalizes them and keeps its own p4 path and client. */
const ClientPerforceSettings = z.unknown().optional()

const FilePaths = z.array(z.string().min(1, 'Missing file path')).min(1, 'Missing file paths')
const ChangelistId = z.number().int().positive()
const ChangelistTarget = z.union([z.literal('default'), ChangelistId])

export const PerforceWorktree = WorktreeSelector.extend({ settings: ClientPerforceSettings })

export const PerforceHistory = PerforceWorktree.extend({
  limit: z.number().int().min(1).max(200).optional()
})

export const PerforceFile = PerforceWorktree.extend({
  filePath: z.string().min(1, 'Missing file path')
})

export const PerforceFiles = PerforceWorktree.extend({ filePaths: FilePaths })

export const PerforceDiscard = PerforceWorktree.extend({
  entries: z
    .array(z.object({ path: z.string().min(1), group: z.string(), action: z.string() }))
    .min(1)
})

export const PerforceSubmit = PerforceWorktree.extend({
  changelist: ChangelistTarget,
  message: z.string().optional()
})

export const PerforceChangelist = PerforceWorktree.extend({ changelist: ChangelistId })

export const PerforceUnshelveFrom = PerforceWorktree.extend({
  sourceChangelist: ChangelistId,
  changelist: ChangelistTarget
})

export const PerforceChangelistFiles = PerforceChangelist.extend({ filePaths: FilePaths })

export const PerforceShelvedFiles = PerforceChangelist.extend({
  depotPaths: z.array(z.string().min(1)).min(1)
})

export const PerforceCreateChangelist = PerforceWorktree.extend({
  description: z.string(),
  filePaths: z.array(z.string().min(1))
})

export const PerforceEditDescription = PerforceChangelist.extend({ description: z.string() })

export const PerforceMoveToChangelist = PerforceWorktree.extend({
  filePaths: FilePaths,
  changelist: ChangelistTarget
})

/** The client's agent choices ride along like git.generateCommitMessage's; unset ones are the host's. */
export const PerforceGenerateDescription = PerforceWorktree.extend({
  changelist: z.union([z.literal('default'), z.literal('new'), ChangelistId]),
  filePaths: FilePaths,
  agentCmdOverrides: z.record(z.string(), z.string()).optional(),
  defaultTuiAgent: OptionalTuiAgent.nullable()
})

/** A Perforce folder project, for its copy operations; `repo` is a repo selector (`id:<repoId>`). */
export const PerforceProject = z.object({
  repo: z.string().trim().min(1, 'Missing project selector'),
  settings: ClientPerforceSettings
})

export const PerforceCopy = PerforceProject.extend({ name: z.string().min(1, 'Missing copy name') })

export const PerforceRemoveCopy = PerforceCopy.extend({
  revertOpenFiles: z.boolean().optional(),
  deleteShelves: z.boolean().optional(),
  endHolders: z
    .array(z.object({ pid: z.number().int().positive(), startedAt: z.number().nullable() }))
    .optional()
})
