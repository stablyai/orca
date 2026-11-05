import { z } from 'zod'
import { spec, WORKER_ONLY } from './plugin-host-method-spec'

export const PLUGIN_APPEARANCE_SINCE = '1.4.249'
const revision = z.string().regex(/^[a-f0-9]{64}$/)
const artifact = z
  .string()
  .min(1)
  .max(16 * 1024)

export const pluginAppearanceApplyParams = z.strictObject({
  expectedRevision: revision,
  app: artifact,
  terminal: artifact
})

export const PLUGIN_APPEARANCE_API = {
  'appearance.read': spec({
    summary: 'Reads the current desktop appearance revision for a conditional update.',
    since: 4,
    scope: 'desktop',
    capability: 'appearance:write',
    mutation: false,
    surfaces: WORKER_ONLY,
    params: z.strictObject({}).optional(),
    result: z.strictObject({ revision })
  }),
  'appearance.apply': spec({
    summary:
      'Publishes owned app/editor and terminal colors and selects them in the desktop. Returns publication, not renderer acknowledgement.',
    since: 4,
    scope: 'desktop',
    capability: 'appearance:write',
    mutation: true,
    surfaces: WORKER_ONLY,
    params: pluginAppearanceApplyParams,
    result: z.strictObject({
      revision,
      themeId: z.templateLiteral(['plugin:', z.string()]),
      mode: z.enum(['dark', 'light']),
      delivery: z.literal('published')
    })
  })
}
