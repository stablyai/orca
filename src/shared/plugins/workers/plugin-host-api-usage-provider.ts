import { z } from 'zod'
import { pluginUsageProviderUpdateSchema } from '../contributions/plugin-usage-provider-contribution'
import { spec, WORKER_ONLY } from './plugin-host-method-spec'

export const PLUGIN_USAGE_PROVIDER_API = {
  'usageProvider.update': spec({
    summary:
      'Publishes the current quota for one of the calling plugin’s `contributes.usageProviders` entries. Replace the status, accounts, and optional display-safe error together. Send up to eight accounts and eight named windows in total, with percentages from 0 to 100 and optional `resetsAt` timestamps in Unix milliseconds. Send `status: "ok"` with no accounts or error to clear the reading. Orca records the observation time and expires the reading after 30 minutes. An approved plugin declaring a usage provider has a resident worker.',
    since: 11,
    scope: 'plugin-private',
    capability: null,
    mutation: false,
    surfaces: WORKER_ONLY,
    params: pluginUsageProviderUpdateSchema,
    result: z.strictObject({ ok: z.literal(true) })
  })
}
