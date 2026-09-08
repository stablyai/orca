import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { MobileWebManifestSchema } from './manifest-contract'
import { parseMobileWebBridgeMessageDocument } from './bridge-message-parser'
import { MOBILE_WEB_BRIDGE_PROTOCOL_VERSION } from './bridge-limits'

const BridgeMessageSchema = z
  .object({
    version: z.literal(MOBILE_WEB_BRIDGE_PROTOCOL_VERSION),
    shellSessionId: z.string(),
    buildId: z.string(),
    type: z.literal('routeState'),
    route: z.string(),
    depth: z.number().int().nonnegative().max(64)
  })
  .strict()

// The native store used to re-scan every document with a hand-written exact-JSON parser. These
// cases decide what that scanner was actually buying over a strict schema on a parsed value.
describe('hostile JSON documents against strict schemas', () => {
  it('rejects __proto__ as an unknown key on both shapes', () => {
    expect(
      MobileWebManifestSchema.safeParse(JSON.parse(manifestJson('"__proto__":{"polluted":true},')))
        .success
    ).toBe(false)
    expect(parseDocument(bridgeJson('"__proto__":{"polluted":true},'))).toEqual({
      ok: false,
      error: 'invalid_message'
    })
    // JSON.parse never invokes the prototype setter, so the pollution is only ever an own key.
    expect(Object.getPrototypeOf(JSON.parse('{"__proto__":{"polluted":true}}'))).toBe(
      Object.prototype
    )
  })

  it('rejects unsafe numbers through the schema bounds', () => {
    for (const unsafe of ['1e999', '12345678901234567890', '-1', '1.5']) {
      expect(parseDocument(bridgeJson(`"depth":${unsafe},`, { omitDepth: true }))).toEqual({
        ok: false,
        error: 'invalid_message'
      })
    }
    expect(
      MobileWebManifestSchema.safeParse(JSON.parse(manifestJson('', { totalBytes: '1e999' })))
        .success
    ).toBe(false)
  })

  // These two are the whole reason a text scan survives the exact-JSON parser's deletion.
  it('needs the scan for a duplicate key, which the schema can never see', () => {
    const duplicated = JSON.parse('{"depth":1,"depth":2}') as { depth: number }
    expect(duplicated).toEqual({ depth: 2 })

    expect(parseDocument(bridgeJson('"route":"/a",'))).toEqual({
      ok: false,
      error: 'invalid_message'
    })
    // An escaped key spells the same name, so comparing raw literals would miss it.
    expect(parseDocument(bridgeJson('"\\u0072oute":"/a",'))).toEqual({
      ok: false,
      error: 'invalid_message'
    })
  })

  it('needs the scan for an unpaired surrogate, which parses into a valid string', () => {
    expect(z.string().safeParse(JSON.parse('"\\ud800"')).success).toBe(true)

    for (const escape of ['\\ud800', '\\udc00']) {
      expect(parseDocument(bridgeJson(`"route":"${escape}",`, { omitRoute: true }))).toEqual({
        ok: false,
        error: 'invalid_message'
      })
    }
    // A well-formed pair is ordinary text and must still be accepted.
    expect(
      parseDocument(bridgeJson('"route":"\\ud83d\\ude00",', { omitRoute: true }))
    ).toMatchObject({ ok: true })
  })

  it('accepts the same documents without the hostile shape', () => {
    expect(parseDocument(bridgeJson(''))).toMatchObject({ ok: true })
    expect(MobileWebManifestSchema.safeParse(JSON.parse(manifestJson(''))).success).toBe(true)
  })
})

function parseDocument(raw: string) {
  return parseMobileWebBridgeMessageDocument(raw, BridgeMessageSchema)
}

function bridgeJson(
  injected: string,
  options: { omitDepth?: boolean; omitRoute?: boolean } = {}
): string {
  const route = options.omitRoute ? '' : '"route":"/workspaces",'
  const depth = options.omitDepth ? '' : '"depth":1'
  return `{${injected}"version":${MOBILE_WEB_BRIDGE_PROTOCOL_VERSION},"shellSessionId":"s","buildId":"b","type":"routeState",${route}${depth}}`
}

function manifestJson(injected: string, options: { totalBytes?: string } = {}): string {
  const documentHash = 'a'.repeat(64)
  return `{${injected}"schemaVersion":1,"buildId":"${'c'.repeat(64)}","bridge":{"minimum":1,"testedThrough":1},"entrypoint":"index.html","totalBytes":${options.totalBytes ?? 12},"assets":[{"path":"index.html","sha256":"${documentHash}","byteLength":12,"contentType":"text/html; charset=utf-8","role":"document"}]}`
}
