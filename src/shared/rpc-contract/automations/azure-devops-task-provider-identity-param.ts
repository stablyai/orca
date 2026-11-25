import * as z from 'zod'

export const AzureDevOpsTaskProviderIdentityParam = z
  .object({
    provider: z.literal('azure-devops'),
    organization: z.string().nullable().optional(),
    project: z.string().nullable().optional(),
    teamId: z.string().nullable().optional(),
    teamName: z.string().nullable().optional()
  })
  .passthrough()
