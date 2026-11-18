// The Google OAuth client a team creates once (type "Desktop app") and drops into Orca. Google
// treats a Desktop client's id and secret as public; what each person grants stays on their host.

import * as z from 'zod'

/** The largest client file Orca reads; Google's are well under 1 KB. */
export const GOOGLE_CLIENT_FILE_MAX_BYTES = 64 * 1024

export const GOOGLE_CREDENTIALS_PAGE = 'https://console.cloud.google.com/apis/credentials'

/** Where the client came from: a file imported on this host; `team` is kept for a client Orca Cloud may serve later. */
export const GOOGLE_CLIENT_SOURCES = ['imported', 'team'] as const

export const GoogleClientConfigSchema = z.object({
  clientId: z.string().min(1).max(512),
  clientSecret: z.string().min(1).max(512),
  projectId: z.string().min(1).max(256).optional(),
  source: z.enum(GOOGLE_CLIENT_SOURCES),
  savedAt: z.number()
})

export type GoogleClientConfig = z.infer<typeof GoogleClientConfigSchema>

/** What status shows of a client. Only `google.client.export` hands out its secret, which Google treats as public for a Desktop client. */
export type GoogleClientView = Pick<
  GoogleClientConfig,
  'clientId' | 'projectId' | 'source' | 'savedAt'
>

export function googleClientView(config: GoogleClientConfig): GoogleClientView {
  return {
    clientId: config.clientId,
    ...(config.projectId ? { projectId: config.projectId } : {}),
    source: config.source,
    savedAt: config.savedAt
  }
}
