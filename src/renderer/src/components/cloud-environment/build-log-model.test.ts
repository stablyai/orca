import { describe, expect, it } from 'vitest'
import {
  BuildLogBuffer,
  classifyLogLine,
  MAX_OPEN_LINE_CHARS,
  parseStepMarker,
  trimCarriageFrames
} from './build-log-model'
import { deriveBuildSteps, focusStep, formatStepDuration } from './build-steps'
import type { EnvironmentBuildView } from './cloud-environment-types'

function syncBuffer(): { buffer: BuildLogBuffer; flushes: () => number } {
  let count = 0
  const buffer = new BuildLogBuffer((flush) => {
    count += 1
    flush()
  })
  return { buffer, flushes: () => count }
}

function build(overrides: Partial<EnvironmentBuildView> = {}): EnvironmentBuildView {
  return {
    id: 'bld_1',
    number: 7,
    status: 'running',
    active: false,
    createdBy: 'u',
    createdAt: 1_000,
    startedAt: 21_000,
    snapshotStartedAt: null,
    finishedAt: null,
    durationMs: null,
    activatable: false,
    error: null,
    failedStep: null,
    revision: 1,
    machineSize: 'standard',
    repos: [],
    diskUsedBytes: null,
    diskTotalBytes: null,
    logBytes: 0,
    logTruncated: false,
    ...overrides
  }
}

describe('step markers', () => {
  it('parses only known script steps', () => {
    expect(parseStepMarker('::orca-step:: clone')).toBe('clone')
    expect(parseStepMarker('  ::orca-step:: install  ')).toBe('install')
    expect(parseStepMarker('::orca-step:: record')).toBe('record')
    expect(parseStepMarker('::orca-step:: snapshot')).toBeNull()
    expect(parseStepMarker('echo ::orca-step:: clone')).toBeNull()
  })
})

describe('classifyLogLine', () => {
  it('flags errors heuristically but not routine zero-error summaries', () => {
    expect(classifyLogLine('npm ERR! code ELIFECYCLE').kind).toBe('error')
    expect(classifyLogLine('fatal: repository not found').kind).toBe('error')
    expect(classifyLogLine('Build failed with 2 errors').kind).toBe('error')
    expect(classifyLogLine('Found 0 errors.').kind).toBe('plain')
    expect(classifyLogLine('no errors found').kind).toBe('plain')
    expect(classifyLogLine('npm WARN deprecated foo@1').kind).toBe('warning')
    expect(classifyLogLine('Done in 3.2s').kind).toBe('plain')
    expect(classifyLogLine('E: Unable to locate package foo').kind).toBe('error')
    expect(classifyLogLine('W: Some index files failed to download').kind).toBe('error')
    expect(classifyLogLine('W: GPG key is stored in legacy keyring').kind).toBe('warning')
  })

  it('unwraps Orca error lines', () => {
    expect(classifyLogLine('::orca-error:: pnpm install exited 1')).toEqual({
      kind: 'orca-error',
      text: 'pnpm install exited 1'
    })
  })
})

describe('BuildLogBuffer', () => {
  it('splits chunks into lines, joining partial lines across chunks', () => {
    const { buffer } = syncBuffer()
    buffer.append('stdout', 'hel')
    buffer.append('stdout', 'lo\nwor')
    buffer.append('stdout', 'ld\n')
    expect(buffer.lines.map((line) => line.plain)).toEqual(['hello', 'world'])
  })

  it('assigns lines to steps from markers and hides the marker lines', () => {
    const { buffer } = syncBuffer()
    buffer.append('stdout', 'booting\n::orca-step:: clone\n', 100)
    buffer.append('stdout', 'Cloning into app\n::orca-step:: ins', 200)
    buffer.append('stdout', 'tall\npnpm i\n::orca-step:: record\nok\n', 300)
    expect(buffer.lines.map((line) => [line.step, line.plain])).toEqual([
      ['boot', 'booting'],
      ['clone', 'Cloning into app'],
      ['install', 'pnpm i'],
      ['record', 'ok']
    ])
    expect(buffer.markers.clone).toEqual({ lineIndex: 1, at: 100 })
    expect(buffer.markers.install?.lineIndex).toBe(2)
    expect(buffer.stepRange('clone')).toEqual({ start: 1, end: 2 })
    expect(buffer.stepRange('install')).toEqual({ start: 2, end: 3 })
    expect(buffer.stepRange('record')).toEqual({ start: 3, end: 4 })
    expect(buffer.stepRange('snapshot')).toEqual({ start: 4, end: 4 })
  })

  it('collects Orca errors and keeps the final carriage-return frame', () => {
    const { buffer } = syncBuffer()
    buffer.append('stdout', 'progress 10%\rprogress 100%\n')
    buffer.append('stderr', '::orca-error:: install script exited 1\n')
    expect(buffer.lines[0].plain).toBe('progress 100%')
    expect(buffer.orcaErrors).toEqual(['install script exited 1'])
    expect(buffer.lines[1].kind).toBe('orca-error')
    expect(buffer.orcaErrorLines).toEqual([1])
    expect(buffer.outputLineCount('boot')).toBe(1)
  })

  it('strips ANSI for plain text but keeps it for rendering', () => {
    const { buffer } = syncBuffer()
    buffer.append('stdout', '\u001b[31mred error\u001b[0m\n')
    expect(buffer.lines[0].plain).toBe('red error')
    expect(buffer.lines[0].text).toContain('\u001b[31m')
    expect(buffer.lines[0].kind).toBe('error')
  })

  it('closes a partial line when the other stream writes', () => {
    const { buffer } = syncBuffer()
    buffer.append('stdout', 'partial')
    buffer.append('stderr', 'warn line\n')
    buffer.append('stdout', ' more\n')
    expect(buffer.lines.map((line) => line.plain)).toEqual(['partial', 'warn line', ' more'])
  })

  it('keeps only the last progress frame of an open line (no quadratic regrowth)', () => {
    const { buffer } = syncBuffer()
    buffer.append('stdout', 'p 0%')
    for (let i = 1; i <= 5000; i += 1) {
      buffer.append('stdout', `\rp ${i}%`)
    }
    expect(buffer.lines).toHaveLength(1)
    expect(buffer.lines[0].plain).toBe('p 5000%')
    expect(buffer.lines[0].text.length).toBeLessThan(16)
    buffer.append('stdout', '\n')
    expect(buffer.lines[0].plain).toBe('p 5000%')
  })

  it('caps an open line at 64k characters', () => {
    const { buffer } = syncBuffer()
    for (let i = 0; i < 30; i += 1) {
      buffer.append('stdout', 'x'.repeat(10_000))
    }
    expect(buffer.lines[0].text.length).toBe(MAX_OPEN_LINE_CHARS)
  })

  it('registers a partial Orca error or step marker when the other stream interrupts it', () => {
    const { buffer } = syncBuffer()
    buffer.append('stdout', '::orca-step:: clone')
    buffer.append('stderr', 'cloning\n')
    buffer.append('stdout', '::orca-error:: clone failed')
    buffer.append('stderr', 'tail\n')
    expect(buffer.markers.clone?.lineIndex).toBe(0)
    expect(buffer.lines[0]).toMatchObject({ plain: 'cloning', step: 'clone' })
    expect(buffer.orcaErrors).toEqual(['clone failed'])
  })

  it('trims carriage-return frames but keeps a trailing return for the next frame', () => {
    expect(trimCarriageFrames('a\rb\rc')).toBe('c')
    expect(trimCarriageFrames('a\rb\r')).toBe('b\r')
    expect(trimCarriageFrames('plain')).toBe('plain')
  })

  it('reset clears everything (stream replay)', () => {
    const { buffer } = syncBuffer()
    buffer.append('stdout', '::orca-step:: clone\nx\n')
    buffer.reset()
    expect(buffer.lines).toEqual([])
    expect(buffer.markers).toEqual({})
    buffer.append('stdout', 'y\n')
    expect(buffer.lines[0].step).toBe('boot')
  })

  it('batches notifications through the scheduler', () => {
    const queued: (() => void)[] = []
    const buffer = new BuildLogBuffer((flush) => queued.push(flush))
    let notified = 0
    buffer.subscribe(() => {
      notified += 1
    })
    for (let i = 0; i < 100; i += 1) {
      buffer.append('stdout', `line ${i}\n`)
    }
    expect(queued).toHaveLength(1)
    queued[0]()
    expect(notified).toBe(1)
    expect(buffer.getVersion()).toBe(1)
  })

  it('copies text grouped by step', () => {
    const { buffer } = syncBuffer()
    buffer.append(
      'stdout',
      '::orca-step:: clone\ncloned\n::orca-step:: install\n::orca-error:: boom\n'
    )
    expect(buffer.text()).toBe('== clone ==\ncloned\n== install ==\n::orca-error:: boom')
  })
})

describe('deriveBuildSteps', () => {
  it('times boot from createdAt to startedAt and ticks the running step', () => {
    const steps = deriveBuildSteps(
      build(),
      {
        clone: { lineIndex: 0, at: 22_000 },
        install: { lineIndex: 3, at: 30_000 }
      },
      45_000
    )
    expect(steps.map((step) => step.status)).toEqual([
      'succeeded',
      'succeeded',
      'running',
      'pending',
      'pending'
    ])
    expect(steps[0].durationMs).toBe(20_000)
    expect(steps[1].durationMs).toBe(8_000)
    expect(steps[2].durationMs).toBe(15_000)
    expect(focusStep(steps)).toBe('install')
  })

  it('marks the failed step and skips the rest', () => {
    const steps = deriveBuildSteps(
      build({
        status: 'failed',
        failedStep: 'install',
        error: 'install_failed',
        finishedAt: 60_000
      }),
      {
        clone: { lineIndex: 0, at: 22_000 },
        install: { lineIndex: 3, at: 30_000 }
      },
      99_000
    )
    expect(steps.map((step) => step.status)).toEqual([
      'succeeded',
      'succeeded',
      'failed',
      'skipped',
      'skipped'
    ])
    expect(steps[2].durationMs).toBe(30_000)
    expect(focusStep(steps)).toBe('install')
  })

  it('is all green when the build succeeded, with the snapshot window', () => {
    const steps = deriveBuildSteps(
      build({
        status: 'succeeded',
        snapshotStartedAt: 50_000,
        finishedAt: 70_000
      }),
      {
        clone: { lineIndex: 0, at: 22_000 },
        install: { lineIndex: 1, at: 25_000 },
        record: { lineIndex: 2, at: 48_000 }
      },
      99_000
    )
    expect(steps.every((step) => step.status === 'succeeded')).toBe(true)
    expect(steps[3].durationMs).toBe(2_000)
    expect(steps[4].durationMs).toBe(20_000)
    expect(focusStep(steps)).toBeNull()
  })

  it('shows boot running while starting', () => {
    const steps = deriveBuildSteps(build({ status: 'starting', startedAt: null }), {}, 5_000)
    expect(steps[0]).toMatchObject({ status: 'running', durationMs: 4_000 })
    expect(steps.slice(1).every((step) => step.status === 'pending')).toBe(true)
  })

  it('marks the reached step canceled', () => {
    const steps = deriveBuildSteps(
      build({ status: 'canceled', finishedAt: 40_000 }),
      { clone: { lineIndex: 0, at: 22_000 } },
      99_000
    )
    expect(steps.map((step) => step.status)).toEqual([
      'succeeded',
      'canceled',
      'skipped',
      'skipped',
      'skipped'
    ])
  })
})

describe('formatStepDuration', () => {
  it('formats compactly', () => {
    expect(formatStepDuration(null)).toBe('')
    expect(formatStepDuration(4_200)).toBe('4s')
    expect(formatStepDuration(125_000)).toBe('2m 05s')
    expect(formatStepDuration(3_725_000)).toBe('62m 05s')
  })
})
