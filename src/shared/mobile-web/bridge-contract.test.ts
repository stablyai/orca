import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  MOBILE_WEB_BRIDGE_MAX_OPERATION_BYTES,
  MOBILE_WEB_BRIDGE_MAX_MESSAGE_BYTES,
  MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
  MobileWebBridgePageMessageSchema,
  MobileWebBridgeShellMessageSchema,
  parseMobileWebBridgeInitialMessage,
  parseMobileWebBridgePageMessage,
  parseMobileWebBridgeShellMessage
} from './bridge-contract'

const SHELL_SESSION_ID = 'S'.repeat(43)
const REQUEST_ID = 'R'.repeat(22)
const SUBSCRIPTION_ID = 'U'.repeat(22)
const BUILD_ID = 'a'.repeat(64)
const CONTEXT = { shellSessionId: SHELL_SESSION_ID, buildId: BUILD_ID }

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

function operationGrant(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    capability: 'workspace',
    operation: 'snapshot',
    limits: {
      maxRequestBytes: 16 * 1024,
      maxResponseBytes: 128 * 1024,
      maxConcurrent: 4,
      rateCapacity: 10,
      rateRefillPerSecond: 5
    },
    ...overrides
  }
}

describe('mobile web bridge page contract', () => {
  it('accepts exact one-shot, subscription, lifecycle, route, and cancellation envelopes', () => {
    expect(MobileWebBridgePageMessageSchema.safeParse(pageRequest()).success).toBe(true)
    expect(
      MobileWebBridgePageMessageSchema.safeParse(
        pageRequest({ mode: 'subscription', subscriptionId: SUBSCRIPTION_ID })
      ).success
    ).toBe(true)
    expect(
      MobileWebBridgePageMessageSchema.safeParse({
        version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
        type: 'health',
        state: 'interactive',
        shellSessionId: SHELL_SESSION_ID,
        buildId: BUILD_ID
      }).success
    ).toBe(true)
    expect(
      MobileWebBridgePageMessageSchema.safeParse({
        version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
        type: 'hardwareBackCapability',
        revision: 1,
        shellSessionId: SHELL_SESSION_ID,
        buildId: BUILD_ID
      }).success
    ).toBe(true)
    expect(
      MobileWebBridgePageMessageSchema.safeParse({
        version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
        type: 'hardwareBackResult',
        sequence: 4,
        handled: true,
        shellSessionId: SHELL_SESSION_ID,
        buildId: BUILD_ID
      }).success
    ).toBe(true)
    expect(
      MobileWebBridgePageMessageSchema.safeParse({
        version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
        type: 'ready',
        shellSessionId: SHELL_SESSION_ID,
        buildId: BUILD_ID
      }).success
    ).toBe(true)
    expect(
      MobileWebBridgePageMessageSchema.safeParse({
        version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
        type: 'routeState',
        shellSessionId: SHELL_SESSION_ID,
        buildId: BUILD_ID,
        route: { kind: 'session', workspaceId: 'opaque-workspace', workspaceName: 'Feature' }
      }).success
    ).toBe(true)
    expect(
      MobileWebBridgePageMessageSchema.safeParse({
        version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
        type: 'cancel',
        shellSessionId: SHELL_SESSION_ID,
        buildId: BUILD_ID,
        target: 'subscription',
        id: SUBSCRIPTION_ID
      }).success
    ).toBe(true)
  })

  it('rejects health messages before they claim the interactive state', () => {
    expect(
      MobileWebBridgePageMessageSchema.safeParse({
        version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
        type: 'health',
        state: 'loaded',
        shellSessionId: SHELL_SESSION_ID,
        buildId: BUILD_ID
      }).success
    ).toBe(false)
  })

  it('keeps the ready frame valid for old strict shells before declaring Back support', () => {
    const legacyReadySchema = z
      .object({
        version: z.literal(MOBILE_WEB_BRIDGE_PROTOCOL_VERSION),
        type: z.literal('ready'),
        shellSessionId: z.literal(SHELL_SESSION_ID),
        buildId: z.literal(BUILD_ID)
      })
      .strict()
    const ready = {
      version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
      type: 'ready',
      shellSessionId: SHELL_SESSION_ID,
      buildId: BUILD_ID
    }
    const declaration = { ...ready, type: 'hardwareBackCapability', revision: 1 }

    expect(legacyReadySchema.safeParse(ready).success).toBe(true)
    expect(legacyReadySchema.safeParse(declaration).success).toBe(false)
    expect(MobileWebBridgePageMessageSchema.safeParse(declaration).success).toBe(true)
  })

  it('rejects unsupported Back revisions and unbounded result sequences', () => {
    const envelope = {
      version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
      shellSessionId: SHELL_SESSION_ID,
      buildId: BUILD_ID
    }
    expect(
      MobileWebBridgePageMessageSchema.safeParse({
        ...envelope,
        type: 'hardwareBackCapability',
        revision: 2
      }).success
    ).toBe(false)
    expect(
      MobileWebBridgePageMessageSchema.safeParse({
        ...envelope,
        type: 'hardwareBackResult',
        sequence: Number.MAX_SAFE_INTEGER + 1,
        handled: false
      }).success
    ).toBe(false)
  })

  it.each(['branches', 'history', 'branchCompare', 'commitCompare'])(
    'accepts the explicit source-control %s operation',
    (operation) => {
      expect(
        MobileWebBridgePageMessageSchema.safeParse(
          pageRequest({ capability: 'sourceControl', operation })
        ).success
      ).toBe(true)
    }
  )

  it.each([
    ['unknown capability', { capability: 'rpc', operation: 'call' }],
    ['generic RPC operation', { capability: 'workspace', operation: 'rpc.call' }],
    ['generic native operation', { capability: 'native', operation: 'invoke' }],
    ['unknown operation pair', { capability: 'terminal', operation: 'writeFile' }]
  ])('rejects %s', (_label, overrides) => {
    expect(MobileWebBridgePageMessageSchema.safeParse(pageRequest(overrides)).success).toBe(false)
  })

  it('rejects unknown fields and identifiers that are not exact base64url lengths', () => {
    expect(
      MobileWebBridgePageMessageSchema.safeParse(pageRequest({ credential: 'secret' })).success
    ).toBe(false)
    expect(
      MobileWebBridgePageMessageSchema.safeParse(pageRequest({ requestId: 'short' })).success
    ).toBe(false)
    expect(
      MobileWebBridgePageMessageSchema.safeParse(pageRequest({ shellSessionId: 'S'.repeat(44) }))
        .success
    ).toBe(false)
    expect(
      MobileWebBridgePageMessageSchema.safeParse(pageRequest({ requestId: '+'.repeat(22) })).success
    ).toBe(false)
    expect(
      MobileWebBridgePageMessageSchema.safeParse(
        pageRequest({ shellSessionId: `${SHELL_SESSION_ID}\n` })
      ).success
    ).toBe(false)
    expect(
      MobileWebBridgePageMessageSchema.safeParse(pageRequest({ buildId: `${BUILD_ID}\n` })).success
    ).toBe(false)
    expect(
      MobileWebBridgePageMessageSchema.safeParse(pageRequest({ requestId: `${REQUEST_ID}\n` }))
        .success
    ).toBe(false)
    expect(
      MobileWebBridgePageMessageSchema.safeParse(
        pageRequest({
          mode: 'subscription',
          subscriptionId: REQUEST_ID
        })
      ).success
    ).toBe(false)
  })

  it.each([
    null,
    [],
    {},
    7,
    'message',
    { ...pageRequest(), type: 'unknown' },
    { ...pageRequest(), mode: 'subscription' },
    { ...pageRequest(), payload: {}, operation: 7 },
    { ...pageRequest(), requestId: REQUEST_ID, extra: { nested: true } }
  ])('fails closed for malformed envelope corpus case %#', (value) => {
    expect(parseMobileWebBridgePageMessage(JSON.stringify(value), CONTEXT)).toEqual({
      ok: false,
      error: 'invalid_message'
    })
  })

  it('rejects malformed, oversized, unsupported, and stale messages with stable codes', () => {
    expect(parseMobileWebBridgePageMessage('{', CONTEXT)).toEqual({
      ok: false,
      error: 'invalid_message'
    })
    expect(
      parseMobileWebBridgePageMessage('x'.repeat(MOBILE_WEB_BRIDGE_MAX_MESSAGE_BYTES + 1), CONTEXT)
    ).toEqual({ ok: false, error: 'too_large' })
    expect(
      parseMobileWebBridgePageMessage(
        JSON.stringify(pageRequest({ version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION + 1 })),
        CONTEXT
      )
    ).toEqual({ ok: false, error: 'unsupported_version' })
    expect(
      parseMobileWebBridgePageMessage(
        JSON.stringify(pageRequest({ shellSessionId: 'T'.repeat(43) })),
        CONTEXT
      )
    ).toEqual({ ok: false, error: 'stale_session' })
    expect(
      parseMobileWebBridgePageMessage(
        JSON.stringify(pageRequest({ buildId: 'b'.repeat(64) })),
        CONTEXT
      )
    ).toEqual({ ok: false, error: 'stale_session' })
  })
})

describe('mobile web bridge shell contract', () => {
  it('accepts unique, bounded operation grants', () => {
    expect(
      MobileWebBridgeShellMessageSchema.safeParse({
        version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
        type: 'init',
        shellSessionId: SHELL_SESSION_ID,
        buildId: BUILD_ID,
        connection: 'connected',
        hostDisplayName: 'Host 1',
        reconnectAttempts: 3,
        lastConnectedAt: 1_721_234_567_890,
        resumeRoute: {
          kind: 'session',
          workspaceId: 'opaque-workspace',
          workspaceName: 'Feature'
        },
        grants: [operationGrant(), operationGrant({ capability: 'terminal', operation: 'input' })]
      }).success
    ).toBe(true)
  })

  it('ignores a newer same-capability grant while keeping page requests allowlisted', () => {
    expect(
      MobileWebBridgeShellMessageSchema.safeParse({
        version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
        type: 'init',
        shellSessionId: SHELL_SESSION_ID,
        buildId: BUILD_ID,
        connection: 'connected',
        grants: [operationGrant({ capability: 'native', operation: 'futureOperation' })]
      }).success
    ).toBe(true)
    expect(
      MobileWebBridgePageMessageSchema.safeParse(
        pageRequest({ capability: 'native', operation: 'futureOperation' })
      ).success
    ).toBe(false)
  })

  it('accepts hardware Back requests without changing init or grants', () => {
    expect(
      MobileWebBridgeShellMessageSchema.safeParse({
        version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
        type: 'hardwareBack',
        shellSessionId: SHELL_SESSION_ID,
        buildId: BUILD_ID,
        sequence: 1
      }).success
    ).toBe(true)
  })

  it('applies exact JSON admission to the initial shell message', () => {
    const initial = JSON.stringify({
      version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
      type: 'init',
      shellSessionId: SHELL_SESSION_ID,
      buildId: BUILD_ID,
      connection: 'connected',
      grants: [operationGrant()]
    })
    expect(parseMobileWebBridgeInitialMessage(initial)).toMatchObject({
      ok: true,
      value: { type: 'init', connection: 'connected' }
    })

    const duplicateConnection = initial.replace(
      '"connection":"connected"',
      '"connection":"offline","\\u0063onnection":"connected"'
    )
    expect(parseMobileWebBridgeInitialMessage(duplicateConnection)).toEqual({
      ok: false,
      error: 'invalid_message'
    })
    expect(
      parseMobileWebBridgeInitialMessage(
        initial.replace(`"${SHELL_SESSION_ID}"`, `"${String.fromCharCode(0xd800)}"`)
      )
    ).toEqual({ ok: false, error: 'invalid_message' })
    expect(parseMobileWebBridgeInitialMessage(`${initial} trailing`)).toEqual({
      ok: false,
      error: 'invalid_message'
    })
    expect(
      parseMobileWebBridgeInitialMessage(
        JSON.stringify({
          version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION + 1,
          type: 'init',
          shellSessionId: SHELL_SESSION_ID,
          buildId: BUILD_ID,
          connection: 'connected',
          grants: []
        })
      )
    ).toEqual({ ok: false, error: 'unsupported_version' })
    expect(
      parseMobileWebBridgeInitialMessage('x'.repeat(MOBILE_WEB_BRIDGE_MAX_MESSAGE_BYTES + 1))
    ).toEqual({ ok: false, error: 'too_large' })
  })

  // Stripped rather than rejected: `init` carries every grant, so dropping the frame over one
  // undeclared key from a newer shell costs the page every capability. The key is still never
  // readable by the page, which is the whole point of the fence.
  it.each(['hostId', 'hostIdentity', 'publicKeyB64', 'deviceToken', 'endpoint', 'credential'])(
    'strips privileged %s state from the initial page message',
    (field) => {
      const parsed = parseMobileWebBridgeInitialMessage(
        JSON.stringify({
          version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
          type: 'init',
          shellSessionId: SHELL_SESSION_ID,
          buildId: BUILD_ID,
          connection: 'connected',
          grants: [operationGrant()],
          [field]: 'credential-secret'
        })
      )

      expect(parsed).toMatchObject({ ok: true })
      expect(parsed.ok && parsed.value).not.toHaveProperty(field)
    }
  )

  it('keeps a route the shell cannot name out of its resume memory', () => {
    // Why: page->shell stays strict, so the shell only ever remembers a kind it can replay.
    expect(
      MobileWebBridgePageMessageSchema.safeParse({
        version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
        type: 'routeState',
        shellSessionId: SHELL_SESSION_ID,
        buildId: BUILD_ID,
        route: { kind: 'someFutureKind', workspaceId: 'opaque-workspace' }
      }).success
    ).toBe(false)
  })

  it('degrades a resume route kind a newer shell added instead of failing the whole init', () => {
    const base = {
      version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
      type: 'init',
      shellSessionId: SHELL_SESSION_ID,
      buildId: BUILD_ID,
      connection: 'connected',
      grants: [operationGrant(), operationGrant({ capability: 'terminal', operation: 'input' })]
    }
    const raw = JSON.stringify({
      ...base,
      resumeRoute: { kind: 'someFutureKind', workspaceId: 'opaque-workspace' }
    })

    // Why: init is the page's only grant delivery, so a route it cannot name must cost the route.
    for (const parsed of [
      parseMobileWebBridgeShellMessage(raw, CONTEXT),
      parseMobileWebBridgeInitialMessage(raw)
    ]) {
      expect(parsed.ok).toBe(true)
      const value = (parsed as Extract<typeof parsed, { ok: true }>).value as {
        resumeRoute?: unknown
        grants: unknown[]
      }
      expect(value.resumeRoute).toBeUndefined()
      expect(value.grants).toHaveLength(2)
    }
  })

  it('rejects unbounded resume routes and strips host-shaped ones', () => {
    const base = {
      version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
      type: 'init',
      shellSessionId: SHELL_SESSION_ID,
      buildId: BUILD_ID,
      connection: 'connected',
      grants: [operationGrant()]
    }
    expect(
      MobileWebBridgeShellMessageSchema.safeParse({
        ...base,
        resumeRoute: {
          kind: 'session',
          workspaceId: 'opaque-workspace',
          workspaceName: 'x'.repeat(241)
        }
      }).success
    ).toBe(false)
    expect(
      parseMobileWebBridgeShellMessage(
        JSON.stringify({
          ...base,
          resumeRoute: {
            kind: 'session',
            workspaceId: 'opaque-workspace',
            workspaceName: 'x'.repeat(241)
          }
        }),
        CONTEXT
      )
    ).toEqual({ ok: false, error: 'invalid_message' })

    const parsed = parseMobileWebBridgeShellMessage(
      JSON.stringify({
        ...base,
        resumeRoute: {
          kind: 'session',
          workspaceId: 'opaque-workspace',
          workspaceName: 'Feature',
          hostPath: '/private/worktree'
        }
      }),
      CONTEXT
    )
    expect(parsed).toMatchObject({ ok: true })
    expect(parsed.ok && parsed.value).toMatchObject({
      resumeRoute: { kind: 'session', workspaceName: 'Feature' }
    })
    expect(parsed.ok && (parsed.value as { resumeRoute: object }).resumeRoute).not.toHaveProperty(
      'hostPath'
    )
  })

  it('bounds the optional local host display name', () => {
    const base = {
      version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
      type: 'init',
      shellSessionId: SHELL_SESSION_ID,
      buildId: BUILD_ID,
      connection: 'connected',
      grants: [operationGrant()]
    }
    expect(
      MobileWebBridgeShellMessageSchema.safeParse({ ...base, hostDisplayName: 'Host 1' }).success
    ).toBe(true)
    expect(
      MobileWebBridgeShellMessageSchema.safeParse({
        ...base,
        hostDisplayName: 'x'.repeat(161)
      }).success
    ).toBe(false)
  })

  it('bounds optional shell connection metrics', () => {
    const connection = {
      version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
      type: 'connection',
      shellSessionId: SHELL_SESSION_ID,
      buildId: BUILD_ID,
      state: 'recovering'
    }

    expect(
      MobileWebBridgeShellMessageSchema.safeParse({
        ...connection,
        reconnectAttempts: 12,
        lastConnectedAt: null
      }).success
    ).toBe(true)
    expect(
      MobileWebBridgeShellMessageSchema.safeParse({
        ...connection,
        reconnectAttempts: -1,
        lastConnectedAt: Date.now()
      }).success
    ).toBe(false)
    expect(
      MobileWebBridgeShellMessageSchema.safeParse({
        ...connection,
        reconnectAttempts: 1,
        lastConnectedAt: Number.MAX_SAFE_INTEGER + 1
      }).success
    ).toBe(false)
  })

  it('accepts bounded opaque navigation and rejects host-shaped destinations', () => {
    const navigation = {
      version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
      type: 'navigation',
      shellSessionId: SHELL_SESSION_ID,
      buildId: BUILD_ID,
      sequence: 1,
      route: {
        kind: 'session',
        workspaceId: 'workspace_opaque',
        workspaceName: 'Feature'
      }
    }
    expect(MobileWebBridgeShellMessageSchema.safeParse(navigation).success).toBe(true)
    expect(
      MobileWebBridgeShellMessageSchema.safeParse({
        ...navigation,
        route: { kind: 'tasks', taskSource: 'gitlab' }
      }).success
    ).toBe(true)
    expect(
      MobileWebBridgeShellMessageSchema.safeParse({
        ...navigation,
        route: { kind: 'tasks', taskSource: 'jira' }
      }).success
    ).toBe(false)
    expect(
      MobileWebBridgeShellMessageSchema.safeParse({
        ...navigation,
        route: { ...navigation.route, hostWorkspaceId: '/private/orca' }
      }).success
    ).toBe(false)
    expect(
      MobileWebBridgeShellMessageSchema.safeParse({
        version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
        type: 'init',
        shellSessionId: SHELL_SESSION_ID,
        buildId: BUILD_ID,
        connection: 'connected',
        grants: [operationGrant()],
        resumeRoute: { kind: 'accounts' }
      }).success
    ).toBe(false)
    expect(
      MobileWebBridgeShellMessageSchema.safeParse({ ...navigation, sequence: -1 }).success
    ).toBe(false)
  })

  it('rejects duplicate grants and limits above bridge resource bounds', () => {
    const base = {
      version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
      type: 'init',
      shellSessionId: SHELL_SESSION_ID,
      buildId: BUILD_ID,
      connection: 'connected'
    }
    expect(
      MobileWebBridgeShellMessageSchema.safeParse({
        ...base,
        grants: [operationGrant(), operationGrant()]
      }).success
    ).toBe(false)
    expect(
      MobileWebBridgeShellMessageSchema.safeParse({
        ...base,
        grants: [
          operationGrant({
            limits: {
              maxRequestBytes: MOBILE_WEB_BRIDGE_MAX_MESSAGE_BYTES + 1,
              maxResponseBytes: 1,
              maxConcurrent: 1,
              rateCapacity: 1,
              rateRefillPerSecond: 1
            }
          })
        ]
      }).success
    ).toBe(false)
  })

  it('reserves envelope capacity around the largest operation payload', () => {
    expect(
      MobileWebBridgeShellMessageSchema.safeParse({
        version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
        type: 'response',
        shellSessionId: SHELL_SESSION_ID,
        buildId: BUILD_ID,
        requestId: REQUEST_ID,
        status: 'success',
        payload: { text: 'x'.repeat(MOBILE_WEB_BRIDGE_MAX_OPERATION_BYTES - 64) }
      }).success
    ).toBe(true)
    expect(
      MobileWebBridgeShellMessageSchema.safeParse({
        version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
        type: 'init',
        shellSessionId: SHELL_SESSION_ID,
        buildId: BUILD_ID,
        connection: 'connected',
        grants: [
          operationGrant({
            limits: {
              maxRequestBytes: MOBILE_WEB_BRIDGE_MAX_OPERATION_BYTES + 1,
              maxResponseBytes: 1,
              maxConcurrent: 1,
              rateCapacity: 1,
              rateRefillPerSecond: 1
            }
          })
        ]
      }).success
    ).toBe(false)
  })

  it('allows stable error codes but never a raw host or native error message', () => {
    const response = {
      version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
      type: 'response',
      shellSessionId: SHELL_SESSION_ID,
      buildId: BUILD_ID,
      requestId: REQUEST_ID,
      status: 'error',
      error: { code: 'host_error', retryable: true }
    }
    expect(MobileWebBridgeShellMessageSchema.safeParse(response).success).toBe(true)

    // The message is stripped rather than fatal, so the page keeps the error code it can act on
    // and still cannot read the host path inside the message.
    const parsed = parseMobileWebBridgeShellMessage(
      JSON.stringify({
        ...response,
        error: { ...response.error, message: '/private/path: permission denied' }
      }),
      CONTEXT
    )
    expect(parsed).toMatchObject({ ok: true })
    expect(parsed.ok && parsed.value).toMatchObject({
      error: { code: 'host_error', retryable: true }
    })
    expect(parsed.ok && (parsed.value as { error: object }).error).not.toHaveProperty('message')
  })

  it('parses matching shell events and rejects stale subscription events', () => {
    const event = {
      version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
      type: 'event',
      shellSessionId: SHELL_SESSION_ID,
      buildId: BUILD_ID,
      subscriptionId: SUBSCRIPTION_ID,
      sequence: 7,
      payload: { state: 'changed' }
    }
    expect(parseMobileWebBridgeShellMessage(JSON.stringify(event), CONTEXT)).toEqual({
      ok: true,
      value: event
    })
    expect(
      parseMobileWebBridgeShellMessage(
        JSON.stringify({ ...event, shellSessionId: 'T'.repeat(43) }),
        CONTEXT
      )
    ).toEqual({ ok: false, error: 'stale_session' })
  })
})
