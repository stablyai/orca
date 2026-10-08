import { describe, expect, it } from 'vitest'
import {
  isWordlessProviderFrame,
  type ProviderFrameRowText
} from './native-chat-provider-frame-summary'

function frameRow(provider: string, kind: string, extra: Partial<ProviderFrameRowText> = {}) {
  return { text: `${provider} · ${kind}`, providerFrame: { provider, kind }, ...extra }
}

describe('isWordlessProviderFrame', () => {
  it('reads a row whose only text is the host fallback label as wordless', () => {
    expect(isWordlessProviderFrame(frameRow('codex', 'notification:future/event'))).toBe(true)
  })

  it('keeps rows that carry words, a tone, a failure or an answered request', () => {
    expect(
      isWordlessProviderFrame({ ...frameRow('codex', 'notification:x'), text: 'Sandbox degraded' })
    ).toBe(false)
    expect(isWordlessProviderFrame(frameRow('codex', 'notification:x', { tone: 'error' }))).toBe(
      false
    )
    expect(isWordlessProviderFrame(frameRow('codex', 'request:future/request'))).toBe(false)
    expect(isWordlessProviderFrame({ text: 'plain status' })).toBe(false)
  })

  // Hosts before the output was read into the row's text stored `/usage` output only in the
  // payload, so those rows still carry the label; they stay drawn with the payload behind them.
  it("keeps a Claude local command's row an older host wrote with only the label", () => {
    expect(isWordlessProviderFrame(frameRow('claude', 'message:system:local_command_output'))).toBe(
      false
    )
  })
})
