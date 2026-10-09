import { describe, expect, it } from 'vitest'
import { isProviderDiagnosticPersonText } from './provider-diagnostic-person-text'

describe('provider explanations a person can read', () => {
  it.each([
    'Claude does not support the image type .bmp',
    'Claude does not support the image my_photo.bmp. Please use a PNG image.',
    'Not enough messages to compact.',
    'Too many requests',
    'Reconnecting... 2/5',
    'Set ANTHROPIC_API_KEY, then try again.',
    'GPT4 is not available on this plan.',
    'Set AWS_S3_BUCKET, then try again.',
    'Export R2_ACCESS_KEY first.',
    'Model GPT_4O is not available.',
    'Uses {{agent}} $t(key) <b>&</b>'
  ])('keeps readable words: %s', (text) => {
    expect(isProviderDiagnosticPersonText(text)).toBe(true)
  })

  it.each([
    'provider_write_failed: stand-in rejected the turn.',
    'The provider did not accept this message: provider_write_failed: stand-in rejected the turn.',
    'The send failed. new_transport_marker: a future failure',
    'The send failed:\nnew_transport_marker: a future failure',
    'new_transport_marker: a future failure',
    '{"jsonrpc":"2.0","error":{"code":-32603,"message":"failed"}}',
    'The request failed: {"code":-32603}',
    'API Error: Request was aborted.',
    'TypeError: Cannot read properties of undefined',
    'write EPIPE',
    'Internal error: CAPTURE_PROVIDER_400',
    'The request failed with ERR_42.',
    'The configured provider has no API key.',
    'The Provider did not accept this message.',
    'The providers did not accept this message.',
    'HTTP 502 Bad Gateway',
    'RPC -32603',
    'stream disconnected before completion: error sending request for url (http://127.0.0.1:9/v1/responses)',
    'stream disconnected before completion',
    'Request failed at https://example.test/v1/responses',
    'Failure\n    at send (/app/dispatch.ts:10:2)',
    'Traceback (most recent call last):',
    'data: {"type":"error"}',
    '\u001b[31mFailed\u001b[0m',
    ''
  ])('withholds technical text: %s', (text) => {
    expect(isProviderDiagnosticPersonText(text)).toBe(false)
  })
})
