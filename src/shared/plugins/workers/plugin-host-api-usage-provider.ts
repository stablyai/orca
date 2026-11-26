import { z } from 'zod'
import { pluginUsageProviderUpdateSchema } from '../contributions/plugin-usage-provider-contribution'
import { spec, WORKER_ONLY } from './plugin-host-method-spec'

export const PLUGIN_USAGE_PROVIDER_API = {
  'usageProvider.update': spec({
    summary:
      'Publishes the current quota for one of the calling plugin’s `contributes.usageProviders` entries. Replace the status, accounts, and optional display-safe error together. Send up to eight accounts and eight named windows in total, with percentages from 0 to 100 and optional `resetsAt` timestamps in Unix milliseconds. To clear the reading, send `{ id, status: "ok", accounts: [] }` and omit `error`. Orca records the observation time and expires the reading after 30 minutes. Orca desktop and Electron-backed `orca serve` start a resident worker for approved plugins that declare usage providers. Standalone `orcad` skips plugin worker startup.',
    since: 11,
    scope: 'plugin-private',
    capability: null,
    mutation: false,
    surfaces: WORKER_ONLY,
    params: pluginUsageProviderUpdateSchema,
    result: z.strictObject({ ok: z.literal(true) })
  })
}
