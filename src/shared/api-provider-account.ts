import { z } from 'zod'

export const ApiProviderAccountSchema = z.object({
  label: z.string().trim().min(1).max(120),
  baseUrl: z.url().refine((value) => {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
  }, 'Use an HTTPS API endpoint without credentials or query parameters.'),
  model: z.string().trim().min(1).max(200)
})

export const AddApiProviderAccountSchema = ApiProviderAccountSchema.extend({
  apiKey: z.string().trim().min(1).max(4096).regex(/^\S+$/, 'API keys cannot contain whitespace.')
})

export type ApiProviderAccount = z.infer<typeof ApiProviderAccountSchema>
export type AddApiProviderAccount = z.infer<typeof AddApiProviderAccountSchema>
