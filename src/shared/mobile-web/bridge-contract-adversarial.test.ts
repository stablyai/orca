import { describe, expect, it } from 'vitest'
import {
  MOBILE_WEB_BRIDGE_MAX_MESSAGE_BYTES,
  MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
  parseMobileWebBridgePageMessage,
  parseMobileWebBridgeShellMessage
} from './bridge-contract'

const SHELL_SESSION_ID = 'S'.repeat(43)
const BUILD_ID = 'a'.repeat(64)
const REQUEST_ID = 'R'.repeat(22)
const CONTEXT = { shellSessionId: SHELL_SESSION_ID, buildId: BUILD_ID }

describe('mobile web bridge adversarial corpus', () => {
  it.each(envelopeMutationCorpus())('rejects generated envelope mutation $label', ({ value }) => {
    expect(parseMobileWebBridgePageMessage(JSON.stringify(value), CONTEXT)).toMatchObject({
      ok: false
    })
  })

  it.each([
    ['duplicate type', '"type":"request"', '"type":"ready","type":"request"'],
    ['escaped-equivalent type', '"type":"request"', '"\\u0074ype":"ready","type":"request"'],
    ['duplicate payload key', '"payload":{}', '"payload":{"value":1,"value":2}'],
    ['escaped-equivalent payload key', '"payload":{}', '"payload":{"value":1,"\\u0076alue":2}'],
    ['lone high surrogate', '"payload":{}', '"payload":{"value":"\\uD800"}'],
    ['lone low surrogate', '"payload":{}', '"payload":{"value":"\\uDC00"}']
  ])('rejects raw JSON ambiguity: %s', (_label, target, replacement) => {
    const raw = JSON.stringify(pageRequest()).replace(target, replacement)
    expect(parseMobileWebBridgePageMessage(raw, CONTEXT)).toEqual({
      ok: false,
      error: 'invalid_message'
    })
  })

  it('enforces the raw UTF-8 message ceiling before schema traversal', () => {
    const empty = JSON.stringify(pageRequest({ payload: { value: '' } }))
    const emptyBytes = new TextEncoder().encode(empty).byteLength
    const atLimit = JSON.stringify(
      pageRequest({
        payload: { value: 'x'.repeat(MOBILE_WEB_BRIDGE_MAX_MESSAGE_BYTES - emptyBytes) }
      })
    )
    const overLimit = JSON.stringify(
      pageRequest({
        payload: { value: 'x'.repeat(MOBILE_WEB_BRIDGE_MAX_MESSAGE_BYTES - emptyBytes + 1) }
      })
    )

    expect(new TextEncoder().encode(atLimit)).toHaveLength(MOBILE_WEB_BRIDGE_MAX_MESSAGE_BYTES)
    expect(parseMobileWebBridgePageMessage(atLimit, CONTEXT)).toMatchObject({ ok: true })
    expect(parseMobileWebBridgePageMessage(overLimit, CONTEXT)).toEqual({
      ok: false,
      error: 'too_large'
    })
  })

  it('rejects every stale shell-session and build pairing in a generated context grid', () => {
    const shellSessions = ['T', 'U', 'V'].map((value) => value.repeat(43))
    const builds = ['b', 'c', 'd'].map((value) => value.repeat(64))

    for (const shellSessionId of [SHELL_SESSION_ID, ...shellSessions]) {
      for (const buildId of [BUILD_ID, ...builds]) {
        if (shellSessionId === SHELL_SESSION_ID && buildId === BUILD_ID) {
          continue
        }
        expect(
          parseMobileWebBridgePageMessage(
            JSON.stringify(pageRequest({ shellSessionId, buildId })),
            CONTEXT
          )
        ).toEqual({ ok: false, error: 'stale_session' })
      }
    }
  })

  it.each(shellMutationCorpus())('rejects generated shell mutation $label', ({ value }) => {
    expect(parseMobileWebBridgeShellMessage(JSON.stringify(value), CONTEXT)).toMatchObject({
      ok: false
    })
  })

  // An undeclared key on a shell frame is stripped, not fatal: the shell can be a newer release
  // than the page, and dropping the frame costs the page the whole message. The key still never
  // reaches the page, so the leak fence is unchanged.
  it('strips an undeclared shell field instead of dropping the frame', () => {
    const parsed = parseMobileWebBridgeShellMessage(
      JSON.stringify(shellEvent({ hostPath: '/private/repo' })),
      CONTEXT
    )

    expect(parsed).toMatchObject({ ok: true })
    expect(parsed.ok && parsed.value).not.toHaveProperty('hostPath')
  })
})

function pageRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
    type: 'request',
    mode: 'once',
    shellSessionId: SHELL_SESSION_ID,
    buildId: BUILD_ID,
    requestId: REQUEST_ID,
    capability: 'workspace',
    operation: 'snapshot',
    payload: {},
    ...overrides
  }
}

function envelopeMutationCorpus(): { label: string; value: Record<string, unknown> }[] {
  const cases: { label: string; value: Record<string, unknown> }[] = []
  for (const field of [
    'version',
    'type',
    'mode',
    'shellSessionId',
    'buildId',
    'requestId',
    'capability',
    'operation',
    'payload'
  ]) {
    const value = pageRequest()
    delete value[field]
    cases.push({ label: `missing ${field}`, value })
  }
  for (const [field, values] of Object.entries({
    version: [null, true, '2', -1, 2.5, MOBILE_WEB_BRIDGE_PROTOCOL_VERSION + 1],
    type: [null, true, 1, 'ready', 'unknown'],
    mode: [null, true, 1, 'subscription', 'unknown'],
    shellSessionId: [null, true, 1, '', 'S'.repeat(42), 'S'.repeat(44), '+'.repeat(43)],
    buildId: [null, true, 1, '', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64)],
    requestId: [null, true, 1, '', 'R'.repeat(21), 'R'.repeat(23), '+'.repeat(22)],
    capability: [null, true, 1, '', 'rpc', 'unknown'],
    operation: [null, true, 1, '', 'x'.repeat(41), 'rpc.call', 'unknown']
  })) {
    for (const [index, mutation] of values.entries()) {
      cases.push({
        label: `${field} mutation ${index}`,
        value: pageRequest({ [field]: mutation })
      })
    }
  }
  cases.push(
    { label: 'unknown top-level field', value: pageRequest({ credential: 'secret' }) },
    {
      label: 'subscription without subscription ID',
      value: pageRequest({ mode: 'subscription' })
    },
    {
      label: 'subscription reusing request ID',
      value: pageRequest({ mode: 'subscription', subscriptionId: REQUEST_ID })
    }
  )
  return cases
}

function shellEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
    type: 'event',
    shellSessionId: SHELL_SESSION_ID,
    buildId: BUILD_ID,
    subscriptionId: 'U'.repeat(22),
    sequence: 0,
    payload: {},
    ...overrides
  }
}

function shellMutationCorpus(): { label: string; value: Record<string, unknown> }[] {
  const cases: { label: string; value: Record<string, unknown> }[] = []
  for (const field of [
    'version',
    'type',
    'shellSessionId',
    'buildId',
    'subscriptionId',
    'sequence',
    'payload'
  ]) {
    const value = shellEvent()
    delete value[field]
    cases.push({ label: `shell missing ${field}`, value })
  }
  for (const [field, values] of Object.entries({
    type: [null, true, 1, 'request', 'unknown'],
    subscriptionId: [null, true, 1, '', 'U'.repeat(21), 'U'.repeat(23), '+'.repeat(22)],
    sequence: [null, true, '0', -1, 0.5, Number.MAX_SAFE_INTEGER + 1]
  })) {
    for (const [index, mutation] of values.entries()) {
      cases.push({
        label: `shell ${field} mutation ${index}`,
        value: shellEvent({ [field]: mutation })
      })
    }
  }
  return cases
}
