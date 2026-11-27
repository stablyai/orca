import { z } from 'zod'
import { BrowserTarget, ExpectUrlBrowserTarget, requiredString } from '../rpc-param-primitives'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'

export const Reload = lazyZodSchema(() =>
  ExpectUrlBrowserTarget.extend({
    ignoreCache: z.boolean().optional()
  })
)

export const PageZoom = lazyZodSchema(() =>
  BrowserTarget.extend({
    direction: z.enum(['in', 'out', 'reset'])
  })
)

export const SiteColorScheme = lazyZodSchema(() =>
  BrowserTarget.extend({
    colorScheme: z.enum(['light', 'dark']).nullable()
  })
)

export const AudioMuted = lazyZodSchema(() =>
  BrowserTarget.extend({
    muted: z.boolean()
  })
)

export const FindInPage = lazyZodSchema(() =>
  BrowserTarget.extend({
    text: requiredString('Missing required text'),
    forward: z.boolean().optional(),
    findNext: z.boolean().optional()
  })
)

export const CertificateProceed = lazyZodSchema(() =>
  BrowserTarget.extend({
    challengeId: requiredString('Missing required challengeId')
  })
)

// A streamed page's right-click menu: the spelling word or image it acts on.
export const PageMenuWord = lazyZodSchema(() =>
  BrowserTarget.extend({
    word: requiredString('Missing required word')
  })
)

export const PageMenuImage = lazyZodSchema(() =>
  BrowserTarget.extend({
    url: requiredString('Missing required url')
  })
)

export const ReadImage = lazyZodSchema(() =>
  PageMenuImage.extend({
    offset: z.number().int().nonnegative().optional()
  })
)
