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

export const AudioMuted = BrowserTarget.extend({
  muted: z.boolean()
})

export const FindInPage = BrowserTarget.extend({
  text: requiredString('Missing required text'),
  forward: z.boolean().optional(),
  findNext: z.boolean().optional()
})

export const CertificateProceed = BrowserTarget.extend({
  challengeId: requiredString('Missing required challengeId')
})

// A streamed page's right-click menu: the spelling word or image it acts on.
export const PageMenuWord = BrowserTarget.extend({
  word: requiredString('Missing required word')
})

export const PageMenuImage = BrowserTarget.extend({
  url: requiredString('Missing required url')
})

export const ReadImage = PageMenuImage.extend({
  offset: z.number().int().nonnegative().optional()
})
