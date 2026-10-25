import { z } from 'zod'

export const AppUpdateRemotePhase = z.enum([
  'queued',
  'checking-update',
  'downloading',
  'ready',
  'restarting',
  'updated',
  'current',
  'failed',
  'not-confirmed',
  'verify-after-restart'
])

export const AppUpdateBatchSchema = z.object({
  version: z.literal(1),
  targetVersion: z.string(),
  stage: z.enum(['preparing', 'remotes', 'attention', 'installing', 'recovery']),
  remotes: z.array(
    z.object({
      environmentId: z.string(),
      pairingRevision: z.number().finite(),
      name: z.string(),
      currentVersion: z.string().nullable(),
      targetVersion: z.string().nullable(),
      runtimeId: z.string().nullable(),
      phase: AppUpdateRemotePhase,
      progress: z.number().nullable(),
      error: z.string().nullable()
    })
  ),
  error: z.string().nullable()
})

export type AppUpdateBatch = z.infer<typeof AppUpdateBatchSchema>
export type AppUpdateRemote = AppUpdateBatch['remotes'][number]

export function remoteUpdateNeedsAttention(remote: AppUpdateRemote): boolean {
  return remote.phase === 'failed' || remote.phase === 'not-confirmed'
}
