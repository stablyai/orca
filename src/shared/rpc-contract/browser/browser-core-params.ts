import { z } from 'zod'
import { BrowserTarget, ExpectUrlBrowserTarget, requiredString } from '../rpc-param-primitives'

export const Reload = ExpectUrlBrowserTarget.extend({
  ignoreCache: z.boolean().optional()
})

export const PageZoom = BrowserTarget.extend({
  direction: z.enum(['in', 'out', 'reset'])
})

export const SiteColorScheme = BrowserTarget.extend({
  colorScheme: z.enum(['light', 'dark']).nullable()
})

export const CertificateProceed = BrowserTarget.extend({
  challengeId: requiredString('Missing required challengeId')
})
