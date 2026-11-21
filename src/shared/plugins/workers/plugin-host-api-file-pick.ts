import { z } from 'zod'
import { spec, WORKER_ONLY } from './plugin-host-method-spec'

/** Workers only: a frame never gets a path. No capability: a worker already reads any file. */
export const PLUGIN_FILE_PICK_API = {
  'files.pick': spec({
    summary:
      "Shows Orca's open-file dialog and returns the absolute path of the file the person chose on this computer; `path` is null when they cancel or another open-file dialog is already open. Desktop app only: `unavailable` when no Orca window is showing.",
    since: 11,
    scope: 'desktop',
    capability: null,
    mutation: false,
    surfaces: WORKER_ONLY,
    params: z.strictObject({}).optional(),
    result: z.object({ path: z.string().nullable() })
  })
}
