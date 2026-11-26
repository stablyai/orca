import { z } from 'zod'
import { pluginUsageProviderUpdateSchema } from '../contributions/plugin-usage-provider-contribution'
import { spec, WORKER_ONLY } from './plugin-host-method-spec'

export const PLUGIN_USAGE_PROVIDER_API = {
  'usageProvider.update': spec({
    summary:
      'Publishes the current quota for one of the calling plugin’s `contributes.usageProviders` entries. Pass up to eight windows with distinct whole-minute durations from 1 to 527040, percentages from 0 to 100, and optional `resetsAt` timestamps in Unix milliseconds. An empty list clears the reading. Orca records the observation time and expires the reading after 30 minutes. An approved plugin declaring a usage provider has a resident worker.',
    since: 11,
    scope: 'plugin-private',
    capability: null,
    mutation: false,
    surfaces: WORKER_ONLY,
    params: pluginUsageProviderUpdateSchema,
    result: z.strictObject({ ok: z.literal(true) })
  })
}
