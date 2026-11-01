import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import {
  auditResults,
  prepareBenchmark,
  runDescriptor
} from '../../config/scripts/check-job-log-byte-cap-benchmark.mjs'
import {
  BASELINE_REF,
  createManifest,
  selectRequiredDescriptors
} from '../../config/scripts/check-job-log-performance-cases.mjs'
import { adverseCaseKey } from '../../config/scripts/check-job-log-watchdog-protocol.mjs'

const launcher = vi.hoisted(() => vi.fn())
vi.mock('@orca/process-host', () => ({ runProcess: launcher }))
afterEach(() => {
  launcher.mockReset()
  context.censoredBaselines?.clear()
  vi.unstubAllEnvs()
})

const context = {
  censoredBaselines: new Map(),
  root: process.cwd(),
  identity: {
    baselineRef: BASELINE_REF,
    baselineSourceHashes: { ansi: 'frozen' },
    proposedSourceHashes: { ansi: 'current' }
  },
  bundles: {
    'baseline-negative': { filename: 'baseline.mjs', hash: 'negative-bundle' },
    baseline: { filename: 'baseline.mjs', hash: 'baseline-bundle' },
    proposed: { filename: 'proposed.mjs', hash: 'proposed-bundle' }
  }
}
const adverse = {
  id: 'negative-case',
  mode: 'direct',
  arm: 'baseline',
  family: 'osc',
  width: 7,
  bytes: 16384,
  samples: 7,
  sample: 0,
  baselineTimeoutAllowed: true
}
const ready = (id = adverse.id, bundleHash = context.bundles['baseline-negative'].hash) => ({
  type: 'ready',
  identity: { ...context.identity, id, bundleHash },
  runtime: { node: process.version, platform: process.platform, arch: process.arch, bun: false },
  inputBytes: 16384,
  codeUnits: 16384,
  inputHash: createHash('sha256').update('x'.repeat(16384)).digest('hex')
})
const protocol = (records: unknown[]): string =>
  `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
const timeoutResult = () => ({
  code: null,
  signal: 'SIGTERM',
  timedOut: true,
  outputTruncated: false,
  stderr: '',
  stdout: protocol([ready(), { type: 'entered-strip', phase: 'warmup' }])
})
const watchdogExits = [
  { label: 'SIGTERM', signal: 'SIGTERM', code: null, accepted: true },
  { label: 'SIGKILL', signal: 'SIGKILL', code: null, accepted: true },
  { label: 'numeric one', signal: null, code: 1, accepted: false },
  { label: 'numeric two', signal: null, code: 2, accepted: false },
  { label: 'maximum safe integer', signal: null, code: Number.MAX_SAFE_INTEGER, accepted: false },
  { label: 'unsigned access violation', signal: null, code: 3221225477, accepted: false },
  { label: 'signed access violation', signal: null, code: -1073741819, accepted: false },
  { label: 'fractional code', signal: null, code: 1.5, accepted: false },
  { label: 'zero code', signal: null, code: 0, accepted: false },
  { label: 'null/null', signal: null, code: null, accepted: false },
  { label: 'unexpected signal', signal: 'SIGSEGV', code: null, accepted: false },
  { label: 'unexpected signal/code', signal: 'SIGSEGV', code: 1, accepted: false },
  { label: 'SIGINT', signal: 'SIGINT', code: null, accepted: false },
  { label: 'SIGTERM/code', signal: 'SIGTERM', code: 1, accepted: false },
  { label: 'SIGKILL/code', signal: 'SIGKILL', code: 2, accepted: false }
] as const
const adverseSlots = () =>
  Array.from({ length: 7 }, (_, sample) => ({
    ...adverse,
    id: sample ? `slot-${sample}` : adverse.id,
    samples: 1,
    sample
  }))
const differentials = ['baseline', 'proposed'].map((arm) => ({
  id: `diff-${arm}`,
  mode: 'differential',
  arm
}))
const differentialRecords = differentials.map((item) => ({
  ...item,
  status: 'completed',
  cases: 5126,
  outputHash: 'same'
}))
const watchdog = { id: 'watchdog', mode: 'watchdog', arm: 'proposed' }
const terminationProtocol = (descriptor: typeof adverse | typeof watchdog, platform: string) =>
  protocol([
    {
      ...ready(
        descriptor.id,
        context.bundles[descriptor.mode === 'direct' ? 'baseline-negative' : 'proposed'].hash
      ),
      runtime: { node: process.version, platform, arch: 'x64', bun: false }
    },
    {
      type: descriptor.mode === 'direct' ? 'entered-strip' : 'entered',
      phase: descriptor.mode === 'direct' ? 'warmup' : 'watchdog'
    }
  ])

const malformedProtocols = (descriptor: typeof adverse | typeof watchdog) => {
  const prework = ready(
    descriptor.id,
    context.bundles[descriptor.mode === 'direct' ? 'baseline-negative' : 'proposed'].hash
  )
  const entry = {
    type: descriptor.mode === 'direct' ? 'entered-strip' : 'entered',
    phase: descriptor.mode === 'direct' ? 'warmup' : 'watchdog'
  }
  const result = {
    type: 'result',
    id: descriptor.id,
    mode: descriptor.mode,
    arm: descriptor.arm,
    inputIdentity: {
      inputBytes: prework.inputBytes,
      codeUnits: prework.codeUnits,
      inputHash: prework.inputHash
    }
  }
  return [
    { label: 'wrong result id', records: [prework, entry, { ...result, id: 'wrong' }] },
    { label: 'wrong result mode', records: [prework, entry, { ...result, mode: 'wrong' }] },
    { label: 'wrong result arm', records: [prework, entry, { ...result, arm: 'wrong' }] },
    { label: 'wrong result input', records: [prework, entry, { ...result, inputIdentity: {} }] },
    { label: 'duplicate ready', records: [prework, prework, entry] },
    {
      label: 'mismatched second ready',
      records: [prework, { ...prework, identity: { ...prework.identity, id: 'wrong' } }, entry]
    },
    { label: 'entry before ready', records: [entry, prework] },
    { label: 'duplicate result', records: [prework, entry, result, result] },
    { label: 'result before entry', records: [prework, result, entry] },
    { label: 'completed timeout', records: [prework, entry, result] },
    { label: 'duplicate entry', records: [prework, entry, entry] },
    {
      label: 'pre-call after strip entry',
      records: [prework, entry, { type: 'entered', phase: 'warmup', warmup: 0 }]
    },
    {
      label: 'invalid warmup index',
      records: [prework, { type: 'entered', phase: 'warmup', warmup: -1 }, entry]
    },
    {
      label: 'sample before warmups',
      records: [prework, { type: 'entered', phase: 'sample', sample: 0 }, entry]
    },
    { label: 'unknown entry', records: [prework, { ...entry, type: 'unknown' }, entry] },
    { label: 'invalid entry phase', records: [prework, { ...entry, phase: 'startup' }] },
    { label: 'null record', records: [prework, null, entry] },
    {
      label: 'truthy malformed runtime',
      records: [
        { ...prework, runtime: { node: 'not-node', platform: 42, arch: {}, bun: 0 } },
        entry
      ]
    },
    ...[
      { node: 'not-node' },
      { node: 26 },
      { platform: 42 },
      { arch: {} },
      { bun: 0 },
      { bun: true },
      { platform: '' },
      { arch: '' }
    ].map((runtime) => ({
      label: `invalid runtime ${Object.keys(runtime)[0]}=${JSON.stringify(Object.values(runtime)[0])}`,
      records: [{ ...prework, runtime: { ...prework.runtime, ...runtime } }, entry]
    }))
  ]
}

describe('performance watchdog failure precedence and completeness', () => {
  it('prepares current implementation checks without Git history', async () => {
    const prepared = await prepareBenchmark(process.cwd(), { compareBaseline: false })
    try {
      expect(launcher).not.toHaveBeenCalled()
      expect(Object.keys(prepared.bundles).sort()).toEqual(['proposed', 'proposed-observed'])
      expect(prepared.identity.baselineSourceHashes).toEqual({})
    } finally {
      await prepared.cleanup()
    }
  })
  it('rejects changed historical source in the manual comparison', async () => {
    const success = { code: 0, signal: null, timedOut: false, outputTruncated: false }
    launcher.mockResolvedValueOnce({ ...success, stdout: 'changed historical ANSI source' })
    await expect(prepareBenchmark()).rejects.toThrow(
      'Baseline source changed: ansi-escape-sequences.ts'
    )
    expect(launcher).toHaveBeenCalledTimes(1)
  })
  describe.each(['adverse', 'watchdog'])('%s protocol framing', (branch) => {
    const descriptor = branch === 'adverse' ? adverse : watchdog
    it.each(malformedProtocols(descriptor))(
      'rejects $label before timeout acceptance',
      async (fixture) => {
        launcher.mockResolvedValue({ ...timeoutResult(), stdout: protocol(fixture.records) })
        await expect(runDescriptor(context, descriptor)).rejects.toThrow()
        expect(context.censoredBaselines.size).toBe(0)
      }
    )
  })
  it.each(malformedProtocols(adverse))(
    '$label cannot suppress later attempts or pass audit',
    async (fixture) => {
      const slots = adverseSlots()
      const records: object[] = []
      launcher.mockResolvedValue({ ...timeoutResult(), stdout: protocol(fixture.records) })
      await expect(runDescriptor(context, slots[0])).rejects.toThrow()
      records.push({ ...slots[0], status: 'failed' })
      for (const slot of slots.slice(1)) {
        launcher.mockResolvedValue({
          ...timeoutResult(),
          stdout: terminationProtocol(slot, 'darwin')
        })
        records.push(await runDescriptor(context, slot))
      }
      expect(launcher).toHaveBeenCalledTimes(7)
      expect(records.slice(1).every((record) => Object.hasOwn(record, 'watchdogTermination'))).toBe(
        true
      )
      expect(context.censoredBaselines.size).toBe(0)
      expect(() =>
        auditResults([...slots, ...differentials], [...records, ...differentialRecords])
      ).toThrow('Failed descriptor')
    }
  )
  it.each(['warmup', 'sample'])('preserves a verified partial %s strip entry', async (phase) => {
    launcher.mockResolvedValue({
      ...timeoutResult(),
      stdout: protocol([ready(), { type: 'entered-strip', phase }])
    })
    const record = await runDescriptor(context, adverse)
    expect(record.status).toBe('baseline_timeout')
    expect(record.samples).toEqual([])
    expect(record.unavailableSamples).toBe(7)
    expect(record.deadlineMs).toBe(10000)
    expect(launcher).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 10000,
        maxOutputBytes: 65536,
        env: expect.objectContaining({ ORCA_BACKGROUND_LAUNCH: '1' })
      })
    )
  })
  it.each([
    'startup',
    'identity',
    'truncated',
    'stderr',
    'crash',
    'unexpected-signal',
    'pre-call-only'
  ])('rejects %s failures rather than labeling them baseline timeouts', async (failure) => {
    const result = timeoutResult()
    if (failure === 'startup') {
      result.stdout = ''
    }
    if (failure === 'identity') {
      result.stdout = protocol([ready('wrong-case'), { type: 'entered-strip', phase: 'warmup' }])
    }
    if (failure === 'truncated') {
      result.outputTruncated = true
    }
    if (failure === 'stderr') {
      result.stderr = 'sentinel fixture construction failure'
    }
    if (failure === 'crash') {
      result.timedOut = false
      result.signal = 'SIGSEGV'
    }
    if (failure === 'unexpected-signal') {
      result.signal = 'SIGSEGV'
    }
    if (failure === 'pre-call-only') {
      result.stdout = protocol([ready(), { type: 'entered', phase: 'warmup' }])
    }
    launcher.mockResolvedValue(result)
    await expect(runDescriptor(context, adverse)).rejects.toThrow()
  })
  it.each(['proposed', 'ordinary-baseline'])('rejects %s workload timeouts', async (arm) => {
    const baseline = arm === 'ordinary-baseline'
    const descriptor = {
      ...adverse,
      arm: baseline ? 'baseline' : 'proposed',
      baselineTimeoutAllowed: false
    }
    launcher.mockResolvedValue({
      ...timeoutResult(),
      stdout: protocol([
        ready(descriptor.id, context.bundles[baseline ? 'baseline' : 'proposed'].hash),
        { type: 'entered', phase: 'warmup', warmup: 0 }
      ])
    })
    await expect(runDescriptor(context, descriptor)).rejects.toThrow(
      'Workload child failed or timed out'
    )
  })
  it('censors only remaining slots of the exact verified initial adverse timeout', async () => {
    const initial = { ...adverse, samples: 1 }
    launcher.mockResolvedValue(timeoutResult())
    await runDescriptor(context, initial)
    const later = { ...initial, id: 'later-slot', sample: 1 }
    const record = await runDescriptor(context, later)
    expect(record).toMatchObject({
      status: 'baseline_censored',
      attempted: false,
      initialTimeoutId: initial.id,
      unavailableSamples: 1,
      samples: []
    })
    expect(launcher).toHaveBeenCalledTimes(1)
    expect(record).not.toHaveProperty('settlementMs')
    launcher.mockResolvedValue({ ...timeoutResult(), stdout: '' })
    await expect(runDescriptor(context, { ...later, bytes: 32768 })).rejects.toThrow()
    expect(launcher).toHaveBeenCalledTimes(2)
  })
  it('audits seven logical adverse slots and their initial termination proof', async () => {
    const slots = Array.from({ length: 7 }, (_, sample) => ({
      ...adverse,
      id: sample ? `slot-${sample}` : adverse.id,
      samples: 1,
      sample
    }))
    launcher.mockResolvedValue(timeoutResult())
    const records: Awaited<ReturnType<typeof runDescriptor>>[] = []
    for (const slot of slots) {
      records.push(await runDescriptor(context, slot))
    }
    const differentials = ['baseline', 'proposed'].map((arm) => ({
      id: `diff-${arm}`,
      mode: 'differential',
      arm
    }))
    const results = [
      ...records,
      ...differentials.map((item) => ({
        ...item,
        status: 'completed',
        cases: 5126,
        outputHash: 'same'
      }))
    ]
    const summary = auditResults([...slots, ...differentials], results)
    expect(summary).toMatchObject({
      descriptors: 9,
      attemptedDescriptors: 3,
      censoredSampleSlots: 6,
      censoredBaselines: 1
    })
    expect(() =>
      auditResults(
        [...slots, ...differentials],
        results.map((item) => (item.id === adverse.id ? { ...item, phase: 'startup' } : item))
      )
    ).toThrow()
    expect(() =>
      auditResults(
        [...slots, ...differentials],
        results.map((item) =>
          item.id === 'slot-1' ? { ...item, initialTimeoutId: 'missing' } : item
        )
      )
    ).toThrow('Missing verified initial')
  })
  describe.each(['win32', 'linux', 'darwin'])('%s watchdog evidence', (platform) => {
    describe.each(['adverse', 'watchdog'])('%s classifier and parent audit', (mode) => {
      it.each(watchdogExits)(
        'classifies $label through the actual launcher result',
        async (exit) => {
          const descriptor = mode === 'adverse' ? adverse : watchdog
          launcher.mockResolvedValue({
            ...timeoutResult(),
            code: exit.code,
            signal: exit.signal,
            stdout: terminationProtocol(descriptor, platform)
          })
          if (exit.accepted) {
            expect((await runDescriptor(context, descriptor)).status).toBe(
              mode === 'adverse' ? 'baseline_timeout' : 'watchdog_passed'
            )
          } else {
            await expect(runDescriptor(context, descriptor)).rejects.toThrow(
              'Unverified watchdog termination'
            )
            expect(context.censoredBaselines.size).toBe(0)
          }
        }
      )
      it.each(watchdogExits)('audits independently constructed $label records', (exit) => {
        const slots = adverseSlots()
        const input = ready()
        const initial = {
          ...slots[0],
          status: 'baseline_timeout',
          attempted: true,
          phase: 'warmup',
          deadlineMs: 10000,
          settlementMs: 10001,
          identity: input.identity,
          runtime: { ...input.runtime, platform },
          inputBytes: input.inputBytes,
          codeUnits: input.codeUnits,
          inputHash: input.inputHash,
          watchdogTermination: { timedOut: true, signal: exit.signal, code: exit.code },
          unavailableSamples: 1,
          samples: []
        }
        const manifest = mode === 'adverse' ? slots : [watchdog]
        const records =
          mode === 'adverse'
            ? slots.map((slot) => ({
                ...initial,
                ...slot,
                identity: { ...initial.identity, id: slot.id },
                ...(slot.sample
                  ? {
                      status: 'baseline_censored',
                      attempted: false,
                      initialTimeoutId: initial.id
                    }
                  : {})
              }))
            : [
                {
                  ...watchdog,
                  status: 'watchdog_passed',
                  attempted: true,
                  settlementMs: initial.settlementMs,
                  identity: { ...input.identity, id: watchdog.id },
                  runtime: initial.runtime,
                  code: exit.code,
                  signal: exit.signal,
                  watchdogTermination: initial.watchdogTermination
                }
              ]
        const audit = () =>
          auditResults([...manifest, ...differentials], [...records, ...differentialRecords])
        if (exit.accepted) {
          expect(audit().descriptors).toBe(manifest.length + 2)
        } else {
          expect(audit).toThrow('Unverified watchdog termination')
        }
      })
    })
  })
  it.each(watchdogExits)(
    'revalidates cached initial $label evidence before censoring',
    async (exit) => {
      const input = ready()
      const initial = {
        ...adverse,
        status: 'baseline_timeout',
        attempted: true,
        phase: 'warmup',
        identity: input.identity,
        runtime: input.runtime,
        inputBytes: input.inputBytes,
        codeUnits: input.codeUnits,
        inputHash: input.inputHash,
        deadlineMs: 10000,
        settlementMs: 10001,
        watchdogTermination: { timedOut: true, signal: exit.signal, code: exit.code }
      }
      context.censoredBaselines.set(adverseCaseKey(adverse), initial)
      const run = runDescriptor(context, { ...adverse, id: 'cached-slot', samples: 1, sample: 1 })
      if (exit.accepted) {
        expect(await run).toMatchObject({ status: 'baseline_censored', attempted: false })
      } else {
        await expect(run).rejects.toThrow('Unverified watchdog termination')
      }
      expect(launcher).not.toHaveBeenCalled()
    }
  )
  it.each(watchdogExits.filter((exit) => !exit.accepted))(
    'an initial $label failure leaves all seven slots attempted',
    async (exit) => {
      for (const slot of adverseSlots()) {
        launcher.mockResolvedValue({
          ...timeoutResult(),
          code: exit.code,
          signal: exit.signal,
          stdout: terminationProtocol(slot, 'win32')
        })
        await expect(runDescriptor(context, slot)).rejects.toThrow(
          'Unverified watchdog termination'
        )
      }
      expect(launcher).toHaveBeenCalledTimes(7)
      expect(context.censoredBaselines.size).toBe(0)
    }
  )
  it.each(['adverse', 'watchdog'])(
    'rejects every %s exit without a fired watchdog',
    async (mode) => {
      const descriptor = mode === 'adverse' ? adverse : watchdog
      for (const exit of watchdogExits) {
        launcher.mockResolvedValue({
          ...timeoutResult(),
          timedOut: false,
          code: exit.code,
          signal: exit.signal,
          stdout: terminationProtocol(descriptor, 'win32')
        })
        await expect(runDescriptor(context, descriptor)).rejects.toThrow()
      }
      expect(context.censoredBaselines.size).toBe(0)
    }
  )
  it('audits the actual self-control record and rejects altered status or exit fields', async () => {
    launcher.mockResolvedValue({
      ...timeoutResult(),
      stdout: terminationProtocol(watchdog, 'win32')
    })
    const record = await runDescriptor(context, watchdog)
    const manifest = [watchdog, ...differentials]
    expect(auditResults(manifest, [record, ...differentialRecords]).descriptors).toBe(3)
    for (const altered of [
      { ...record, status: 'completed' },
      { ...record, code: 1 },
      { ...record, signal: 'SIGSEGV' }
    ]) {
      expect(() => auditResults(manifest, [altered, ...differentialRecords])).toThrow()
    }
  })
  it('alternates seven parent-selected pairs at every direct size', () => {
    const direct = createManifest().filter(
      (item) => item.mode === 'direct' && item.family === 'plain'
    )
    for (let pair = 0; pair < direct.length; pair += 28) {
      const sizes = direct.slice(pair, pair + 2).map((item) => item.bytes)
      for (let sample = 0; sample < 7; sample++) {
        const expectedArms = sample % 2 ? ['baseline', 'proposed'] : ['proposed', 'baseline']
        const expectedSizes = sample % 2 ? sizes.toReversed() : sizes
        expect(
          direct
            .slice(pair + sample * 4, pair + sample * 4 + 4)
            .map((item) => [item.arm, item.bytes, item.sample, item.samples])
        ).toEqual(
          expectedArms.flatMap((arm) => expectedSizes.map((bytes) => [arm, bytes, sample, 1]))
        )
      }
    }
  })
  it('predeclares full proposed coverage before adverse baseline descriptors', () => {
    const manifest = createManifest()
    const firstBaseline = manifest.findIndex((item) => item.arm === 'baseline')
    const lastCoverage = manifest.findLastIndex((item) => item.mode === 'coverage')
    expect(lastCoverage).toBeLessThan(firstBaseline)
    expect(new Set(manifest.map((item) => item.id)).size).toBe(manifest.length)
    expect(
      manifest
        .filter((item) => item.baselineTimeoutAllowed)
        .every(
          (item) =>
            item.arm === 'baseline' &&
            item.mode === 'direct' &&
            ['osc', 'dcs', 'apc', 'pm', 'sos'].includes(item.family)
        )
    ).toBe(true)
    expect(
      manifest.some(
        (item) =>
          item.mode === 'coverage' &&
          item.bytes === 63 * 1024 * 1024 &&
          item.width === 8 &&
          item.position === 'earlier'
      )
    ).toBe(true)
  })
  it('selects the required ordered 944 or 1004 descriptors with complete measurement groups', () => {
    const full = createManifest({ capturePath: 'capture.stdout' })
    const selected = selectRequiredDescriptors(full)
    expect(selected).toHaveLength(1004)
    expect(selectRequiredDescriptors(createManifest())).toHaveLength(944)
    expect(full.filter((descriptor) => selected.includes(descriptor))).toEqual(selected)
    const coverage = selected.filter((descriptor) => descriptor.mode === 'coverage')
    const expectedCoverage = ['osc', 'dcs', 'apc', 'pm', 'sos'].flatMap((family) =>
      [7, 8].flatMap((width) =>
        [16384, 32768, 2 * 1024 * 1024, 63 * 1024 * 1024].flatMap((bytes) =>
          ['earlier', 'tail'].map((position) => [family, width, bytes, position])
        )
      )
    )
    expect(
      coverage.map(({ family, width, bytes, position }) => [family, width, bytes, position])
    ).toEqual(expectedCoverage)
    expect(coverage.every((descriptor) => descriptor.variant === 'unfinished')).toBe(true)
    expect(selected.filter((descriptor) => descriptor.mode === 'counts')).toHaveLength(52)
    expect(selected.filter((descriptor) => descriptor.mode === 'retention')).toHaveLength(7)
    for (const family of ['fixture', 'actual']) {
      expect(
        selected.filter((descriptor) => descriptor.mode === 'cpu' && descriptor.family === family)
      ).toHaveLength(60)
    }
    for (const arm of ['baseline', 'proposed', 'baseline-bounded', 'full-log']) {
      expect(
        selected.filter((descriptor) => descriptor.mode === 'cpu' && descriptor.arm === arm)
      ).toHaveLength(40)
    }
    const direct = selected.filter((descriptor) => descriptor.mode === 'direct')
    expect(direct.filter((descriptor) => descriptor.arm === 'baseline')).toHaveLength(280)
    expect(
      direct.filter((descriptor) => descriptor.arm === 'proposed' && descriptor.bytes <= 32768)
    ).toHaveLength(280)
    expect(direct.filter((descriptor) => descriptor.bytes > 32768)).toHaveLength(140)
    const groups = new Map<string, typeof direct>()
    for (const descriptor of direct) {
      const key = JSON.stringify([descriptor.arm, descriptor.family, descriptor.width])
      groups.set(key, [...(groups.get(key) ?? []), descriptor])
    }
    for (const group of groups.values()) {
      const sizes = [...new Set(group.map((descriptor) => descriptor.bytes))].sort(
        (a, b) => Number(a) - Number(b)
      )
      expect(sizes.slice(0, 2)).toEqual([16384, 32768])
      if (sizes.length > 2) {
        expect(sizes.slice(2)).toEqual([31.5 * 1024 * 1024, 63 * 1024 * 1024])
      }
      for (const bytes of sizes) {
        expect(
          group
            .filter((descriptor) => descriptor.bytes === bytes)
            .map((descriptor) => descriptor.sample)
        ).toEqual([0, 1, 2, 3, 4, 5, 6])
      }
    }
  })
  it('fails missing records and never turns an ordinary failure into completed coverage', () => {
    expect(() => auditResults([adverse], [])).toThrow('Incomplete')
    expect(() => auditResults([adverse], [{ id: adverse.id, status: 'failed' }])).toThrow(
      'Failed descriptor'
    )
  })
  it('rejects extra, duplicate, unexpected records and duplicate manifest IDs explicitly', () => {
    const record = { id: adverse.id, status: 'baseline_timeout' }
    expect(() => auditResults([adverse], [record, record])).toThrow('duplicate descriptor')
    expect(() => auditResults([adverse, { ...adverse, id: 'other' }], [record, record])).toThrow(
      'duplicate descriptor'
    )
    expect(() => auditResults([adverse], [{ ...record, id: 'unexpected' }])).toThrow(
      'Unexpected descriptor'
    )
    expect(() => auditResults([adverse, adverse], [record, record])).toThrow('Duplicate manifest')
  })
  it.each(['bytes', 'units', 'hash'])(
    'rejects invalid pre-work input %s identities',
    async (field) => {
      const identity = ready()
      if (field === 'bytes') {
        identity.inputBytes++
      }
      if (field === 'units') {
        identity.codeUnits = -1
      }
      if (field === 'hash') {
        identity.inputHash = 'unverified'
      }
      launcher.mockResolvedValue({
        ...timeoutResult(),
        stdout: protocol([identity, { type: 'entered-strip', phase: 'warmup' }])
      })
      await expect(runDescriptor(context, adverse)).rejects.toThrow()
    }
  )
  it('validates completion input identity against the pre-work protocol', async () => {
    const descriptor = { id: 'control', mode: 'control', arm: 'proposed' }
    const prework = ready(descriptor.id, context.bundles.proposed.hash)
    const inputIdentity = {
      inputBytes: prework.inputBytes,
      codeUnits: prework.codeUnits,
      inputHash: prework.inputHash
    }
    launcher.mockResolvedValue({
      ...timeoutResult(),
      timedOut: false,
      code: 0,
      signal: null,
      stdout: protocol([prework, { type: 'result', ...descriptor, samples: [], inputIdentity }])
    })
    expect(await runDescriptor(context, descriptor)).toMatchObject({
      ...inputIdentity,
      status: 'completed'
    })
    launcher.mockResolvedValue({
      ...timeoutResult(),
      timedOut: false,
      code: 0,
      signal: null,
      stdout: protocol([
        prework,
        {
          type: 'result',
          ...descriptor,
          samples: [],
          inputIdentity: { ...inputIdentity, codeUnits: 1 }
        }
      ])
    })
    await expect(runDescriptor(context, descriptor)).rejects.toThrow(
      'Completion input identity changed'
    )
  })
})
