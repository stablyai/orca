import '../../../src/main/runtime/rpc/unused-default-rpc-methods.test-fixture'
import { execFileSync } from 'node:child_process'
import { stripTypeScriptTypes } from 'node:module'
import { expect, it, vi } from 'vitest'
import {
  call,
  hostStub,
  STRUCTURED_CLIENT
} from '../../../src/main/runtime/rpc/methods/structured-agent-session-rpc.test-fixture'
import { setStructuredAgentSessionHost } from '../../../src/main/native-chat/agent-session-wire/structured-agent-session-registry'
import { createAgentModelCatalogService } from '../../../src/main/native-chat/agent-model-catalog/agent-model-catalog-service'
import { AgentModelCatalogStore } from '../../../src/main/native-chat/agent-model-catalog/agent-model-catalog-store'
import {
  runAgentModelCatalogSession,
  AgentModelCatalogProbeError
} from '../../../src/main/native-chat/agent-model-catalog/agent-model-catalog-probe-runner'
import { createClaudeModelCatalogProbe } from '../../../src/main/claude/claude-model-catalog-probe'

import { REPO_ROOT } from './release-checkout'

// Local acceptance rig: execute the pinned source, with only React's effect scheduler and transport replaced.
function released(path: string, names: string[], dependencies: Record<string, unknown> = {}) {
  const source = execFileSync('git', ['show', `v1.4.229:${path}`], {
    cwd: REPO_ROOT,
    encoding: 'utf8'
  })
    .replace(
      'constructor(private readonly options: RequestTrackerOptions) {}',
      'constructor(options: RequestTrackerOptions) { this.options = options; }'
    )
    .replace(
      /constructor\(\s*readonly code: string,[\s\S]*?super\(message\)\s*\}/,
      'constructor(code: string, message: string, data?: unknown) { super(message); this.code = code; this.data = data; }'
    )
  const javascript = stripTypeScriptTypes(source)
    .replace(/import[\s\S]*?from\s*['"][^'"]+['"];?/g, '')
    .replace(/export /g, '')
  return new Function(
    ...Object.keys(dependencies),
    `${javascript}; return { ${names.join(', ')} };`
  )(...Object.values(dependencies))
}

it.each(['success', 'budget'] as const)(
  'released one-follow tracker accepts direct legacy %s with enterprise retry and cleanup under modern saturation',
  async (mode) => {
    vi.useFakeTimers()
    const start = Date.now()
    const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
    const attempts: boolean[] = []
    let closes = 0
    let output = [
      {
        response: {
          subtype: 'success',
          request_id: 'orca-model-discovery',
          response: { models: [{ value: 'opus', supportsFastMode: true }] }
        }
      },
      {
        response: {
          subtype: 'success',
          request_id: 'orca-model-settings',
          response: { applied: {} }
        }
      }
    ]
      .map((row) => JSON.stringify(row))
      .join('\n')
    const probe = createClaudeModelCatalogProbe({
      resolveCommand: () => process.execPath,
      resolveEnv: () => ({}),
      resolveInheritedEnv: async () => ({}),
      resolveAuthPolicy: () => ({ account: 'system' }),
      runListing: (launch, options) => {
        const strict = launch.args.includes('--strict-mcp-config')
        attempts.push(strict)
        return runAgentModelCatalogSession(
          () => ({
            close: async () => {
              if (!strict) {
                await wait(6_000)
              }
              closes++
            }
          }),
          async () => {
            await wait(strict ? 14_000 : mode === 'success' ? 8_000 : 60_000)
            if (strict) {
              throw new AgentModelCatalogProbeError('enterprise policy', 'exit', false, {
                exitCode: 1,
                stdout: '',
                stderr:
                  'You cannot use --strict-mcp-config when an enterprise MCP config is present'
              })
            }
            return output
          },
          { label: 'released-acceptance', signal: options.signal }
        )
      }
    })
    const modern = vi.fn(
      (signal?: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('stopped')), { once: true })
        })
    )
    const home = { variable: 'CLAUDE_CONFIG_DIR', path: '/qa-account' }
    const scoped = Object.assign(probe, {
      resolve: async (_home: unknown, cwd: string) => ({
        identity: { command: 'qa-modern', cwd },
        run: modern
      })
    })
    const service = createAgentModelCatalogService({
      store: new AgentModelCatalogStore(),
      getRecord: () => undefined,
      getConversation: () => undefined,
      drivesRecord: () => true,
      resolveAccountHome: async () => home,
      probes: { claude: scoped }
    })
    setStructuredAgentSessionHost(
      Object.assign(hostStub(), {
        deps: {
          modelCatalog: service,
          store: { getRecord: () => undefined, getConversation: () => undefined },
          adapter: {}
        }
      })
    )
    const budget = released('mobile/src/transport/rpc-request-budget.ts', [
      'openRpcRequestBudget',
      'resolvePostConnectRequestTimeout'
    ])
    const ambiguity = released('mobile/src/transport/rpc-delivery-ambiguity.ts', [
      'markRpcDeliveryUnknown'
    ])
    const { RpcClientRequestTracker } = released(
      'mobile/src/transport/rpc-client-request-tracker.ts',
      ['RpcClientRequestTracker'],
      { ...budget, ...ambiguity }
    )
    let sequence = 0
    const frames: { params?: unknown }[] = []
    const receipts: boolean[] = []
    const tracker = new RpcClientRequestTracker({
      nextId: () => String(++sequence),
      getState: () => 'connected',
      waitForConnected: async () => {},
      sendFrame: (frame: { id: string; method: string; params?: unknown }) => {
        frames.push(frame)
        void call(frame.method, frame.params, STRUCTURED_CLIENT).then((response) => {
          receipts.push(tracker.resolve({ ...response, id: frame.id }))
        })
        return true
      }
    })
    const { callAgentSession } = released(
      'mobile/src/session/mobile-structured-agent-session-rpc.ts',
      ['callAgentSession']
    )
    let cleanup: (() => void) | undefined
    const applied: unknown[] = []
    let landed = 0
    const record = {}
    const { useMobileHostModelCatalogUpgrade } = released(
      'mobile/src/session/use-mobile-host-model-catalog-upgrade.ts',
      ['useMobileHostModelCatalogUpgrade'],
      {
        callAgentSession,
        useEffect: (effect: () => () => void) => {
          cleanup = effect()
        },
        applyStructuredAgentSessionModelCatalog: (
          _state: unknown,
          _seed: unknown,
          catalog: unknown
        ) => {
          applied.push(catalog)
          return { record }
        },
        settleStructuredAgentSessionBuiltinCatalog: () => {
          throw new Error('released caller timed out')
        }
      }
    )
    try {
      await Promise.all(
        ['/1', '/2', '/3', '/4', '/5'].map((workspacePath) => {
          void service.demand({ agent: 'claude', workspacePath })
          return service.read({ agent: 'claude', workspacePath })
        })
      )
      await vi.advanceTimersByTimeAsync(0)
      expect(modern).toHaveBeenCalledTimes(2)
      useMobileHostModelCatalogUpgrade({
        agent: 'claude',
        client: tracker,
        sessionId: 'released',
        enabled: true,
        newLaunch: false,
        fence: 1,
        optionCatalog: {},
        activeOptionRecordRef: { current: record },
        updateOptionState: (update: (state: { record: object }) => unknown) => update({ record }),
        onListingLanded: () => landed++
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(frames).toHaveLength(2)
      await vi.advanceTimersByTimeAsync(36_000)
      expect(attempts).toEqual([true, false])
      expect(closes).toBe(2)
      expect(receipts).toEqual([true, true])
      expect(tracker.size()).toBe(0)
      expect(applied.at(-1)).not.toHaveProperty('listingInProgress')
      expect(landed).toBe(mode === 'success' ? 1 : 0)
      expect(Date.now() - start).toBeLessThan(45_000)
      if (mode === 'success') {
        cleanup?.()
        await vi.advanceTimersByTimeAsync(120_001)
        output = output.replace('opus', 'sonnet')
        useMobileHostModelCatalogUpgrade({
          agent: 'claude',
          client: tracker,
          sessionId: 'released',
          enabled: true,
          newLaunch: false,
          fence: 1,
          optionCatalog: {},
          activeOptionRecordRef: { current: record },
          updateOptionState: (update: (state: { record: object }) => unknown) => update({ record })
        })
        await vi.advanceTimersByTimeAsync(0)
        expect(frames).toHaveLength(3)
        expect(applied.at(-1)).toMatchObject({ models: [{ id: 'opus' }] })
        await vi.advanceTimersByTimeAsync(34_000)
        expect(frames).toHaveLength(3)
        expect(
          await service.read({ agent: 'claude', legacy: true, savedOnly: true })
        ).toMatchObject({ models: [{ id: 'sonnet' }] })
      }
    } finally {
      cleanup?.()
      service.stop()
      await vi.advanceTimersByTimeAsync(0)
      vi.useRealTimers()
    }
  }
)
