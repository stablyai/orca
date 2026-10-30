import { afterEach, expect, it, vi } from 'vitest'
import * as revisions from '@/runtime/runtime-environment-revision'
import {
  classifyPeerReplacements,
  replacedRuntimeEnvironmentIds,
  resetDeferredPeerChecksForTests
} from '@/store/slices/runtime-environment-peer-replacement'
import {
  createPreviewInputBinding,
  transitionSession,
  type PreviewSession
} from './preview-terminal-input-source'

const allocation = vi.hoisted(() => ({ sources: 0 }))
vi.mock('../terminal-pane/pty-input-source', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../terminal-pane/pty-input-source')>()
  return {
    ...actual,
    createPtyInputSourceBinding: <T>(
      options: Parameters<typeof actual.createPtyInputSourceBinding<T>>[0]
    ) =>
      actual.createPtyInputSourceBinding<T>({
        ...options,
        create: (...args) => {
          allocation.sources += 1
          return options.create(...args)
        }
      })
  }
})

function environment(revision: number, hostKey: string | null = 'key-a') {
  return {
    id: 'scoped-perf',
    createdAt: 1,
    pairingRevision: revision,
    ...(hostKey === null ? {} : { hostKeyFingerprint: hostKey }),
    orcadDeployment: {
      sshTargetId: 'box',
      sshTargetGeneration: 1,
      localPort: 46768,
      remotePort: 6768
    }
  }
}
function publish(
  previous: ReturnType<typeof environment>[],
  next: ReturnType<typeof environment>[]
) {
  revisions.replaceRuntimeEnvironmentRevisions(
    next,
    classifyPeerReplacements(previous, next, replacedRuntimeEnvironmentIds(previous, next))
  )
}
function session(revision: number | undefined) {
  const bytes: string[] = []
  const value: PreviewSession = {
    endpoint: { environmentId: 'scoped-perf', revision, handle: 'term_fixed', incarnationId: 'i1' },
    bindings: new Set(),
    transition: null,
    closed: false,
    ended: false,
    opening: null,
    gate: null,
    snapshotSeq: undefined,
    credits: [],
    grid: null,
    stream: {
      streamId: 1,
      sendInput: (text) => {
        bytes.push(text)
        return true
      },
      acknowledgesInput: () => false,
      inputLedgerId: () => null,
      resize: () => true,
      claimViewport: () => true,
      setOutputPaused: () => true,
      serializeBuffer: async () => null,
      serializeBufferOutcome: async () => ({
        availability: { kind: 'unknown-legacy-host' },
        snapshot: null
      }),
      close: () => {}
    }
  }
  return { value, bytes }
}

// Count scratch and actual visited edges inside the real resolver, excluding fixture/framework Sets.
function countAuthority() {
  const OriginalSet = globalThis.Set
  const resolve = revisions.resolveContinuedRuntimeEnvironmentRevision
  let scratch = 0
  let edges = 0
  class ScratchSet<T> extends OriginalSet<T> {
    constructor(values?: Iterable<T> | null) {
      super(values)
      scratch += 1
    }
    override add(value: T): this {
      edges += 1
      return super.add(value)
    }
  }
  const resolver = vi
    .spyOn(revisions, 'resolveContinuedRuntimeEnvironmentRevision')
    .mockImplementation((id, revision) => {
      vi.stubGlobal('Set', ScratchSet)
      try {
        return resolve(id, revision)
      } finally {
        vi.stubGlobal('Set', OriginalSet)
      }
    })
  const raw = vi.spyOn(revisions, 'getRuntimeEnvironmentRevision')
  return { resolver, raw, counts: () => ({ scratch, edges }) }
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  revisions.replaceRuntimeEnvironmentRevisions([])
  resetDeferredPeerChecksForTests()
})

it.each([10, 100])(
  'bounds real scoped checks and history work at N=%i with positive writes',
  (n) => {
    for (const history of [0, 10, 100]) {
      revisions.replaceRuntimeEnvironmentRevisions([])
      let previous = environment(1)
      publish([], [previous])
      for (let revision = 2; revision <= history + 1; revision += 1) {
        const next = environment(revision)
        publish([previous], [next])
        previous = next
      }
      const { value, bytes } = session(history + 1)
      const binding = createPreviewInputBinding('preview')
      const recordsBeforeAttach = allocation.sources
      binding.attach(value)
      const recordsBeforeInput = allocation.sources
      expect(recordsBeforeInput - recordsBeforeAttach).toBe(1)
      const source = binding.source.current()
      if (!source) {
        throw new Error('missing source')
      }
      const counters = countAuthority()
      for (let i = 0; i < n; i += 1) {
        expect(source.sendInput('x')).toBe(true)
        expect(binding.source.current()).toBe(source)
      }
      expect(allocation.sources).toBe(recordsBeforeInput)
      expect(bytes.join('')).toBe('x'.repeat(n))
      expect(counters.raw).toHaveBeenCalledTimes(n)
      expect(counters.resolver).toHaveBeenCalledTimes(n)
      expect(counters.counts()).toEqual({ scratch: 0, edges: 0 })
      publish([previous], [environment(history + 2)])
      counters.raw.mockClear()
      counters.resolver.mockClear()
      // An unrefreshed session fails its necessary raw equality without walking history.
      value.endpoint = { ...value.endpoint, revision: 1 }
      for (let i = 0; i < n; i += 1) {
        expect(source.sendInput('stale')).toBe(false)
      }
      expect(counters.raw).toHaveBeenCalledTimes(n)
      expect(counters.resolver).not.toHaveBeenCalled()
      expect(bytes).toHaveLength(n)
      binding.dispose()
      vi.restoreAllMocks()
    }
  }
)

it('uses the actual deferred-key producer at an unchanged number and remembers known incarnation', () => {
  const original = environment(1)
  publish([], [original])
  const { value, bytes } = session(1)
  const binding = createPreviewInputBinding('preview')
  binding.attach(value)
  const a = binding.source.current()
  const pending = environment(2, null)
  publish([original], [pending])
  expect(a?.sendInput('unproven')).toBe(false)
  const proved = environment(2)
  publish([pending], [proved])
  transitionSession(value, { ...value.endpoint, revision: 2, incarnationId: null }, () => {
    value.endpoint = { ...value.endpoint, revision: 2, incarnationId: null }
  })
  expect(binding.source.current()).toBe(a)
  expect(a?.sendInput('continued')).toBe(true)
  // A recoverable map absence is not a renderer lifetime or host replacement.
  const stream = value.stream
  value.stream = null
  expect(a?.sendInput('refused-prefix')).toBe(false)
  value.stream = stream
  expect(a?.sendInput('recovered-tail')).toBe(true)
  const replacement = environment(3, 'key-b')
  publish([proved], [replacement])
  expect(a?.sendInput('wrong-host')).toBe(false)
  expect(bytes).toEqual(['continued', 'recovered-tail'])
  binding.dispose()
})

it.each([10, 100])('preserves real-edge/cycle answers and finite scratch at N=%i', (n) => {
  for (const history of [2, 10, 100]) {
    revisions.replaceRuntimeEnvironmentRevisions([])
    const edges = Array.from({ length: history }, (_, i) => ({
      id: 'scoped-perf',
      fromRevision: i + 1,
      toRevision: i + 1 === history ? 1 : i + 2
    }))
    revisions.replaceRuntimeEnvironmentRevisions([environment(2)], { retired: [], sameHost: edges })
    const { value, bytes } = session(2)
    const binding = createPreviewInputBinding('preview')
    binding.attach(value)
    const source = binding.source.current()
    const counters = countAuthority()
    for (let i = 0; i < n; i += 1) {
      // Raw equality cannot skip the actual outgoing cycle edge.
      expect(source?.sendInput('cycle')).toBe(true)
      expect(revisions.resolveContinuedRuntimeEnvironmentRevision('scoped-perf', undefined)).toBe(2)
      expect(revisions.resolveContinuedRuntimeEnvironmentRevision('scoped-perf', 1000)).toBe(1000)
    }
    expect(bytes).toEqual(Array.from({ length: n }, () => 'cycle'))
    expect(counters.resolver).toHaveBeenCalledTimes(3 * n)
    expect(counters.counts()).toEqual({ scratch: n, edges: history * n })
    binding.dispose()
    vi.restoreAllMocks()
  }
})

it.each([10, 100])('reuses the raw undefined compatibility answer at N=%i', (n) => {
  revisions.replaceRuntimeEnvironmentRevisions([])
  const { value, bytes } = session(undefined)
  const binding = createPreviewInputBinding('preview')
  binding.attach(value)
  const counters = countAuthority()
  for (let i = 0; i < n; i += 1) {
    expect(binding.source.current()?.sendInput('legacy')).toBe(true)
  }
  expect(bytes).toHaveLength(n)
  expect(counters.raw).toHaveBeenCalledTimes(n)
  expect(counters.resolver).not.toHaveBeenCalled()
  expect(counters.counts()).toEqual({ scratch: 0, edges: 0 })
  binding.dispose()
})
