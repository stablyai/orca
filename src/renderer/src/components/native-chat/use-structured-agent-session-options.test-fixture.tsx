// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { vi, type Mock } from 'vitest'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type * as LaunchOptions from '@/lib/structured-agent-session-launch-options'
import type * as HostCapability from '@/runtime/structured-agent-session-host-capability'
import type { SelectionOutcome } from '../../../../shared/structured-agent-session-selection-operations'

type OptionsFixtureMocks = {
  call: Mock
  enqueue: Mock
  pick: Mock
  target: RuntimeClientTarget
  agent: 'codex' | 'claude' | 'pi' | 'antigravity'
  hold: Mock<
    (
      sessionId: string,
      id: string,
      encoded: string,
      picker?: unknown
    ) => Promise<SelectionOutcome> | null
  >
  toastError: Mock<(message: string) => void>
  coherentCatalog: boolean
  sendSelection: boolean
}

const mocks: OptionsFixtureMocks = vi.hoisted(() => {
  const selection: {
    target: RuntimeClientTarget
    agent: 'codex' | 'claude' | 'pi' | 'antigravity'
  } = {
    target: { kind: 'local' },
    agent: 'codex'
  }
  return {
    call: vi.fn(),
    enqueue: vi.fn(),
    pick: vi.fn(),
    ...selection,
    hold: vi.fn<
      (
        sessionId: string,
        id: string,
        encoded: string,
        picker?: unknown
      ) => Promise<SelectionOutcome> | null
    >(),
    toastError: vi.fn<(message: string) => void>(),
    coherentCatalog: false,
    sendSelection: false
  }
})

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))

vi.mock('@/runtime/structured-agent-session-host-capability', async () => {
  const actual = await vi.importActual<typeof HostCapability>(
    '@/runtime/structured-agent-session-host-capability'
  )
  return {
    ...actual,
    useStructuredAgentSessionHostCapability: (
      target: RuntimeClientTarget,
      capability: Parameters<typeof actual.useStructuredAgentSessionHostCapability>[1]
    ) => {
      const supported = actual.useStructuredAgentSessionHostCapability(target, capability)
      return (
        (mocks.coherentCatalog && capability === 'agent-session.coherent-model-catalog.v1') ||
        (mocks.sendSelection && capability === 'agent-session.send-selection.v1') ||
        supported
      )
    }
  }
})

vi.mock('@/runtime/structured-agent-session-client', () => ({
  subscribeStructuredAgentSessionStatus: vi.fn(async () => ({ unsubscribe: vi.fn() })),
  callStructuredAgentSession: mocks.call
}))

vi.mock('./native-chat-session-option-settings-write', () => ({
  enqueueSessionOptionSettingsWrite: mocks.enqueue
}))

vi.mock('@/lib/structured-agent-session-launch-options', async () => {
  const { structuredSessionSelectionController } =
    await import('@/lib/structured-agent-session-selection-controller')
  const actual = await vi.importActual<typeof LaunchOptions>(
    '@/lib/structured-agent-session-launch-options'
  )
  return {
    ...actual,
    holdStructuredAgentSessionLaunchOption: (...args: Parameters<typeof mocks.hold>) => {
      const reply = mocks.hold(...args)
      if (!reply) {
        return null
      }
      const controller = structuredSessionSelectionController(mocks.target, args[0], mocks.agent)
      const operation = controller.issue(
        args[1],
        args[2],
        args[1] === 'model' ? args[2] : 'gpt-5.5'
      )
      void reply.then((outcome) => controller.settle(operation, outcome))
      return operation.result
    },
    getStructuredAgentSessionLaunchSelection: () => null
  }
})

import type { SessionOptionDescriptor } from '../../../../shared/native-chat/input/native-chat-session-options'
import {
  useStructuredAgentSessionMutate,
  type StructuredAgentSessionMutate
} from './use-structured-agent-session-mutate'
import { useStructuredAgentSessionOptions } from './use-structured-agent-session-options'
import { useStructuredAgentSessionSendOptions } from './use-structured-agent-session-send-options'

const LOCAL_TARGET = { kind: 'local' } as const
const PAIRED_TARGET = { kind: 'environment', environmentId: 'server-1' } as const

class FakeRpcCallError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

type Answers = {
  options?: () => Promise<unknown>
  modelCatalog?: () => Promise<unknown>
}

function answer(answers: Answers): void {
  mocks.call.mockImplementation(
    async (_target: unknown, method: string, params: { key: string; value: string }) => {
      if (method === 'agentSession.setOption') {
        const value = await mocks.pick(method, method, { key: params.key, value: params.value })
        return value ? { ok: true, value } : Promise.reject(new Error('Unconfirmed option write'))
      }
      if (method === 'agentSession.options' && answers.options) {
        return answers.options()
      }
      if (method === 'agentSession.modelCatalog' && answers.modelCatalog) {
        return answers.modelCatalog()
      }
      return new Promise(() => {})
    }
  )
}

type MutateCall = (...args: unknown[]) => Promise<unknown>

function mutateWith(reply: MutateCall): {
  mutate: StructuredAgentSessionMutate
  calls: ReturnType<typeof vi.fn<MutateCall>>
} {
  const calls = vi.fn<MutateCall>(reply)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each reply is null or the AgentSessionOptionResult shape the hook reads.
  return { mutate: calls as unknown as StructuredAgentSessionMutate, calls }
}

type RenderProps = {
  sessionId?: string
  transportEnabled: boolean
  fence: number | null
  turnId?: string | null
  launch?: 'new' | 'resume'
  hidden?: boolean
  launchSeedOptions?: Record<string, string>
  worktree?: string
  agent?: 'claude' | 'codex' | 'pi' | 'antigravity'
  providerStarting?: boolean
  paired?: boolean
  /** Pass the production presentation scope, which is closed while transport is disabled. */
  presentation?: boolean
}

const PROVISIONAL: RenderProps = { transportEnabled: false, fence: null, launch: 'new' }
// The receipt lands first; attach delivers the fence on a later render.
const PUBLISHED_UNATTACHED: RenderProps = { transportEnabled: true, fence: null, launch: 'new' }
const ATTACHED: RenderProps = { transportEnabled: true, fence: 1, launch: 'new' }
const REOPENED: RenderProps = { transportEnabled: true, fence: 1 }

function renderOptions(initial: RenderProps, mutate: StructuredAgentSessionMutate) {
  mocks.pick.mockImplementation(mutate)
  mocks.target = initial.paired ? PAIRED_TARGET : LOCAL_TARGET
  mocks.agent = initial.agent ?? 'codex'
  return renderHook(
    (props: RenderProps) => {
      const { capturePresentation } = useStructuredAgentSessionMutate({
        sessionId: props.sessionId ?? 'session-1',
        target: props.paired ? PAIRED_TARGET : LOCAL_TARGET,
        stateRef: { current: { fence: props.fence } },
        enabled: props.transportEnabled
      })
      const options = useStructuredAgentSessionOptions({
        agent: props.agent ?? 'codex',
        sessionId: props.sessionId ?? 'session-1',
        target: props.paired ? PAIRED_TARGET : LOCAL_TARGET,
        transportEnabled: props.transportEnabled,
        isVisible: !props.hidden,
        providerVisible: props.transportEnabled && !props.hidden,
        ...(props.providerStarting ? { providerStarting: true } : {}),
        fence: props.fence,
        turnId: props.turnId ?? null,
        unloadedTurnRevisions: undefined,
        mutate,
        ...(props.presentation ? { capturePresentation } : {}),
        ...(props.launch
          ? {
              launch: {
                kind: props.launch,
                ...(props.launchSeedOptions ? { seedOptions: props.launchSeedOptions } : {}),
                ...(props.worktree ? { worktree: props.worktree } : {})
              }
            }
          : {})
      })
      const capture = useStructuredAgentSessionSendOptions(
        props.sessionId ?? 'session-1',
        undefined,
        options.sendSource
      )
      return { ...options, capture }
    },
    { initialProps: initial }
  )
}

function descriptor(snapshot: readonly SessionOptionDescriptor[], id: string) {
  return snapshot.find((entry) => entry.id === id)
}

function currentValue(snapshot: readonly SessionOptionDescriptor[], id: string) {
  const entry = descriptor(snapshot, id)
  return entry?.kind.type === 'select' ? (entry.kind.currentValue ?? null) : null
}

function modelChoiceCount(snapshot: readonly SessionOptionDescriptor[]): number {
  const model = descriptor(snapshot, 'model')
  return model?.kind.type === 'select' ? model.kind.choices.length : 0
}

function setOptionCalls(calls: ReturnType<typeof vi.fn<MutateCall>>): unknown[] {
  return calls.mock.calls
    .filter(([method]) => method === 'agentSession.setOption')
    .map(([, , fields]) => fields)
}

const HOST_CATALOG = {
  origin: 'live-session',
  models: [
    {
      id: 'gpt-hosted',
      label: 'GPT Hosted',
      isDefault: true,
      efforts: [{ value: 'high', label: 'High' }]
    }
  ],
  fetchedAt: 1_000
}

const LIVE_OPTIONS = {
  models: [
    { id: 'gpt-5.5', label: 'GPT-5.5', isDefault: true, efforts: [] },
    { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', efforts: [] }
  ],
  current: { model: 'gpt-5.5', confirmed: ['model'] }
}

const SAVED_LIST = {
  origin: 'probe',
  models: [
    {
      id: 'gpt-5.5',
      label: 'GPT-5.5',
      isDefault: true,
      efforts: [
        { value: 'medium', label: 'Medium' },
        { value: 'high', label: 'High' }
      ]
    },
    { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', efforts: [] }
  ],
  fetchedAt: 1_000
}

const SEED = { model: 'gpt-5.5' }
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

export {
  mocks,
  LOCAL_TARGET,
  PAIRED_TARGET,
  FakeRpcCallError,
  answer,
  mutateWith,
  PROVISIONAL,
  PUBLISHED_UNATTACHED,
  ATTACHED,
  REOPENED,
  renderOptions,
  descriptor,
  currentValue,
  modelChoiceCount,
  setOptionCalls,
  HOST_CATALOG,
  LIVE_OPTIONS,
  SAVED_LIST,
  SEED,
  tick
}

export type { Answers, MutateCall, RenderProps }
