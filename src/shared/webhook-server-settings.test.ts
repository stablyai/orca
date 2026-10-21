import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from './constants'
import { MAX_WEBHOOK_SERVER_PORT, normalizeWebhookServerSettings } from './webhook-server-settings'

describe('normalizeWebhookServerSettings', () => {
  it('defaults to loopback, disabled', () => {
    expect(getDefaultSettings('/tmp').webhookServer).toEqual({
      enabled: false,
      bindAddress: '127.0.0.1',
      port: 8473
    })
  })

  it('clamps the port into the valid range', () => {
    expect(normalizeWebhookServerSettings({ port: 0 }).port).toBe(1)
    expect(normalizeWebhookServerSettings({ port: 999_999 }).port).toBe(MAX_WEBHOOK_SERVER_PORT)
    expect(normalizeWebhookServerSettings({ port: 8473.9 }).port).toBe(8473)
  })

  it('falls back to loopback for a blank bind address', () => {
    expect(normalizeWebhookServerSettings({ bindAddress: '   ' }).bindAddress).toBe('127.0.0.1')
  })

  it('merges partial updates onto current', () => {
    const current = { enabled: true, bindAddress: '0.0.0.0', port: 9000 }
    expect(normalizeWebhookServerSettings({ port: 9100 }, current)).toEqual({
      enabled: true,
      bindAddress: '0.0.0.0',
      port: 9100
    })
  })
})
