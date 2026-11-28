import { expect, it } from 'vitest'
import { redactBrowserMetadata } from './browser-metadata-redaction'

it.each([
  ['https://kagi.com/search?token=certificate-secret&q=one', 'https://kagi.com/search?q=one'],
  ['https://example.com/?token=ordinary', 'https://example.com/?token=ordinary']
])(
  'sanitizes legacy certificate origin metadata without changing ordinary origins: %s',
  (origin, safe) => {
    const certificateFailure = {
      challengeId: 'challenge',
      browserPageId: 'page',
      errorCode: -200,
      error: 'ERR_CERT_COMMON_NAME_INVALID',
      origin,
      displayHost: 'kagi.com',
      canProceed: false,
      observedAt: 1
    }
    expect(redactBrowserMetadata({ url: 'https://example.com/', certificateFailure })).toEqual({
      url: 'https://example.com/',
      certificateFailure: { ...certificateFailure, origin: safe }
    })
  }
)
