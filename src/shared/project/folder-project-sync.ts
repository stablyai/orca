import { z } from 'zod'

export const FOLDER_PROJECT_SYNC_CAPABILITY = 'folder-project-sync.v1' as const

export const FolderProjectSourceId = z.string().uuid()
export const FolderReplica = z.object({
  repoId: z.string().min(1),
  expectedPath: z.string().min(1),
  sourceRepoId: FolderProjectSourceId
})
export const CreateFolderReplica = z.object({
  sourceRepoId: FolderProjectSourceId,
  name: z.string().min(1).max(160)
})

export const FolderReplicaResult = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  kind: z.literal('folder'),
  folderProjectSourceId: FolderProjectSourceId
})

export type FolderReplicaResult = z.infer<typeof FolderReplicaResult>

export const FolderProjectSetupRequest = z.object({
  sourceRepoId: FolderProjectSourceId,
  environmentId: z.string().min(1),
  copyContents: z.boolean(),
  autoSync: z.boolean()
})

export type FolderProjectSetupRequest = z.infer<typeof FolderProjectSetupRequest>

export const FolderProjectSyncTarget = FolderProjectSetupRequest.pick({
  sourceRepoId: true,
  environmentId: true
})

export type FolderProjectSyncTarget = z.infer<typeof FolderProjectSyncTarget>

export const FolderProjectSyncPreference = FolderProjectSyncTarget.extend({
  autoSync: z.boolean()
})

export type FolderProjectSyncPreference = z.infer<typeof FolderProjectSyncPreference>

export type FolderProjectSyncStatus = {
  autoSync: boolean
  conflicts: string[]
  pendingCopy?: boolean
  error?: string
}

export const FolderSyncEntry = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('directory') }),
  z.object({ kind: z.literal('blocked') }),
  z.object({
    kind: z.literal('file'),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    size: z.number().int().nonnegative(),
    executable: z.boolean()
  })
])

export type FolderSyncEntry = z.infer<typeof FolderSyncEntry>

export const FolderSyncManifest = z.array(z.tuple([z.string(), FolderSyncEntry]))

export type FolderSyncManifest = z.infer<typeof FolderSyncManifest>

export const PublishFolderSyncChange = FolderReplica.extend({
  path: z.string().min(1),
  entry: FolderSyncEntry.optional(),
  previous: FolderSyncEntry.optional(),
  stage: z.string().optional()
})
