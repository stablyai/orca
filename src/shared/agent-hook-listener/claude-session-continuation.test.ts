import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClaudeSessionContinuationTracker } from './claude-session-continuation'
import { scanFileRegionsBackward } from './reverse-file-region-scan'
import type * as ReverseFileRegionScan from './reverse-file-region-scan'

vi.mock('./reverse-file-region-scan', async (importOriginal) => {
  const actual = await importOriginal<typeof ReverseFileRegionScan>()
  return { scanFileRegionsBackward: vi.fn(actual.scanFileRegionsBackward) }
})

const OLD = '11111111-1111-4111-8111-111111111111'
const FORK = '22222222-2222-4222-8222-222222222222'
const SECOND_FORK = '33333333-3333-4333-8333-333333333333'
const CLEARED = '44444444-4444-4444-8444-444444444444'
const FILE_ID = '55555555-5555-4555-8555-555555555555'

const createdDirs: string[] = []

afterEach(() => {
  vi.mocked(scanFileRegionsBackward).mockClear()
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function makeProject(): { configDir: string; projectDir: string } {
  const configDir = mkdtempSync(join(tmpdir(), 'claude-continuation-'))
  createdDirs.push(configDir)
  const projectDir = join(configDir, 'projects', '-work-repo')
  mkdirSync(projectDir, { recursive: true })
  return { configDir, projectDir }
}

function line(record: Record<string, unknown>): string {
  return `${JSON.stringify(record)}\n`
}

function turn(sessionId: string, uuid: string): string {
  return line({ type: 'user', sessionId, uuid, cwd: '/work/repo', message: { content: 'hi' } })
}

function pointer(sessionId: string, continuedInSessionId: string): string {
  return line({ type: 'continued-in', sessionId, continuedInSessionId })
}

function writeTranscript(projectDir: string, name: string, body: string): string {
  const transcriptPath = join(projectDir, `${name}.jsonl`)
  writeFileSync(transcriptPath, body)
  return transcriptPath
}

function writeJobState(configDir: string, state: Record<string, unknown>): void {
  const jobDir = join(configDir, 'jobs', String(state.sessionId).slice(0, 8))
  mkdirSync(jobDir, { recursive: true })
  writeFileSync(join(jobDir, 'state.json'), JSON.stringify(state))
}

function session(id: string, transcriptPath: string, cwd?: string) {
  return { key: 'session_id' as const, id, transcriptPath, ...(cwd ? { cwd } : {}) }
}

describe('ClaudeSessionContinuationTracker', () => {
  it('follows a continued-in pointer that is not the last line', () => {
    const { projectDir } = makeProject()
    const oldPath = writeTranscript(
      projectDir,
      OLD,
      turn(OLD, 'u1') + pointer(OLD, FORK) + line({ type: 'cost-state', sessionId: OLD })
    )
    const forkPath = writeTranscript(projectDir, FORK, turn(FORK, 'u1'))

    expect(new ClaudeSessionContinuationTracker().resolve(session(OLD, oldPath))).toEqual(
      session(FORK, forkPath)
    )
  })

  it('returns null when the transcript has no pointer out of this session', () => {
    const { projectDir } = makeProject()
    const oldPath = writeTranscript(projectDir, OLD, turn(OLD, 'u1') + pointer(SECOND_FORK, FORK))
    writeTranscript(projectDir, FORK, turn(FORK, 'u1'))

    expect(new ClaudeSessionContinuationTracker().resolve(session(OLD, oldPath))).toBeNull()
  })

  it('does not rebind to a file that never names the forked session', () => {
    const { projectDir } = makeProject()
    const oldPath = writeTranscript(projectDir, OLD, turn(OLD, 'u1') + pointer(OLD, FORK))
    writeTranscript(projectDir, FORK, turn(SECOND_FORK, 'u1'))

    expect(new ClaudeSessionContinuationTracker().resolve(session(OLD, oldPath))).toBeNull()
  })

  it('retries a pointer whose fork reaches disk after the first check, without rescanning', () => {
    const { projectDir } = makeProject()
    const oldPath = writeTranscript(projectDir, OLD, turn(OLD, 'u1') + pointer(OLD, FORK))
    const tracker = new ClaudeSessionContinuationTracker()
    expect(tracker.resolve(session(OLD, oldPath))).toBeNull()
    expect(tracker.resolve(session(OLD, oldPath))).toBeNull()

    const forkPath = writeTranscript(projectDir, FORK, turn(FORK, 'u1'))
    expect(tracker.resolve(session(OLD, oldPath))).toEqual(session(FORK, forkPath))
    const oldScans = vi.mocked(scanFileRegionsBackward).mock.calls.filter(([p]) => p === oldPath)
    expect(oldScans).toHaveLength(1)
  })

  it('keeps the folder the session ran in when following a fork or a /clear', () => {
    const { configDir, projectDir } = makeProject()
    const oldPath = writeTranscript(projectDir, OLD, turn(OLD, 'u1') + pointer(OLD, FORK))
    const forkPath = writeTranscript(projectDir, FORK, turn(FORK, 'u1'))
    const tracker = new ClaudeSessionContinuationTracker()
    expect(tracker.resolve(session(OLD, oldPath, '/work/repo/pkg'))).toEqual(
      session(FORK, forkPath, '/work/repo/pkg')
    )

    const clearedPath = writeTranscript(projectDir, CLEARED, turn(CLEARED, 'u2'))
    writeJobState(configDir, {
      sessionId: FORK,
      resumeSessionId: CLEARED,
      linkScanPath: clearedPath
    })
    expect(tracker.resolve(session(FORK, forkPath, '/work/repo/pkg'))).toEqual(
      session(CLEARED, clearedPath, '/work/repo/pkg')
    )
  })

  it.each([
    ['a later prompt', turn(OLD, 'u2')],
    [
      'a later finished reply',
      line({ type: 'assistant', sessionId: OLD, message: { stop_reason: 'end_turn' } })
    ]
  ])('ignores a pointer the old session overtook with %s', (_label, later) => {
    const { projectDir } = makeProject()
    const oldPath = writeTranscript(projectDir, OLD, turn(OLD, 'u1') + pointer(OLD, FORK) + later)
    writeTranscript(projectDir, FORK, turn(FORK, 'u1'))

    expect(new ClaudeSessionContinuationTracker().resolve(session(OLD, oldPath))).toBeNull()
  })

  it('still follows a pointer after a tool result, an errored reply, a command or an interrupt', () => {
    const { projectDir } = makeProject()
    const userText = (content: unknown) =>
      line({ type: 'user', sessionId: OLD, message: { content } })
    const oldPath = writeTranscript(
      projectDir,
      OLD,
      turn(OLD, 'u1') +
        pointer(OLD, FORK) +
        userText('<command-name>/clear</command-name>') +
        userText([{ type: 'text', text: '[Request interrupted by user]' }]) +
        userText([{ type: 'text', text: '<system-reminder>x</system-reminder>' }]) +
        line({ type: 'user', sessionId: OLD, message: { content: [{ type: 'tool_result' }] } }) +
        line({
          type: 'assistant',
          sessionId: OLD,
          isApiErrorMessage: true,
          message: { stop_reason: 'stop_sequence' }
        })
    )
    const forkPath = writeTranscript(projectDir, FORK, turn(FORK, 'u1'))

    expect(new ClaudeSessionContinuationTracker().resolve(session(OLD, oldPath))).toEqual(
      session(FORK, forkPath)
    )
  })

  it('follows a fork whose first record is larger than the head it reads', () => {
    const { projectDir } = makeProject()
    const oldPath = writeTranscript(projectDir, OLD, turn(OLD, 'u1') + pointer(OLD, FORK))
    const huge = line({ type: 'user', sessionId: FORK, message: { content: 'x'.repeat(300_000) } })
    const forkPath = writeTranscript(projectDir, FORK, huge)

    expect(new ClaudeSessionContinuationTracker().resolve(session(OLD, oldPath))).toEqual(
      session(FORK, forkPath)
    )
  })

  it('rejects ids and job paths that are not Claude session ids', () => {
    const { configDir, projectDir } = makeProject()
    const escaped = '../../escaped'
    writeTranscript(projectDir, escaped, turn(escaped, 'u1'))
    const oldPath = writeTranscript(projectDir, OLD, turn(OLD, 'u1') + pointer(OLD, escaped))
    expect(new ClaudeSessionContinuationTracker().resolve(session(OLD, oldPath))).toBeNull()

    const forkPath = writeTranscript(projectDir, FORK, turn(FORK, 'u1'))
    writeJobState(configDir, {
      sessionId: FORK,
      resumeSessionId: escaped,
      linkScanPath: join(projectDir, `${escaped}.jsonl`)
    })
    expect(new ClaudeSessionContinuationTracker().resolve(session(FORK, forkPath))).toBeNull()

    writeJobState(configDir, {
      sessionId: FORK,
      resumeSessionId: CLEARED,
      linkScanPath: writeTranscript(projectDir, 'not-a-session', turn(CLEARED, 'u2'))
    })
    expect(new ClaudeSessionContinuationTracker().resolve(session(FORK, forkPath))).toBeNull()
  })

  it('finds a pointer appended after a scan that found none', () => {
    const { projectDir } = makeProject()
    const oldPath = writeTranscript(projectDir, OLD, turn(OLD, 'u1'))
    const forkPath = writeTranscript(projectDir, FORK, turn(FORK, 'u1'))
    const tracker = new ClaudeSessionContinuationTracker()
    expect(tracker.resolve(session(OLD, oldPath))).toBeNull()

    appendFileSync(oldPath, pointer(OLD, FORK))
    expect(tracker.resolve(session(OLD, oldPath))).toEqual(session(FORK, forkPath))
  })

  it('finds a continuation near the end of a large transcript', () => {
    const { projectDir } = makeProject()
    const filler = turn(OLD, 'filler').repeat(Math.ceil((3 * 1024 * 1024) / 90))
    const oldPath = writeTranscript(projectDir, OLD, filler + pointer(OLD, FORK))
    const forkPath = writeTranscript(projectDir, FORK, turn(FORK, 'u1'))

    expect(new ClaudeSessionContinuationTracker().resolve(session(OLD, oldPath))).toEqual(
      session(FORK, forkPath)
    )
  })

  it("uses the job's state when the fork is not named after its session", () => {
    const { configDir, projectDir } = makeProject()
    const oldPath = writeTranscript(projectDir, OLD, turn(OLD, 'u1') + pointer(OLD, FORK))
    const forkPath = writeTranscript(projectDir, FILE_ID, turn(FORK, 'u1'))
    const jobDir = join(configDir, 'jobs', FORK.slice(0, 8))
    mkdirSync(jobDir, { recursive: true })
    writeFileSync(
      join(jobDir, 'state.json'),
      JSON.stringify({ sessionId: FORK, linkScanPath: forkPath })
    )

    expect(new ClaudeSessionContinuationTracker().resolve(session(OLD, oldPath))).toEqual(
      session(FORK, forkPath)
    )
  })

  it("ignores a job state that points outside the old transcript's project", () => {
    const { configDir, projectDir } = makeProject()
    const oldPath = writeTranscript(projectDir, OLD, turn(OLD, 'u1') + pointer(OLD, FORK))
    const elsewhere = join(configDir, 'projects', '-other-repo')
    mkdirSync(elsewhere, { recursive: true })
    const forkPath = writeTranscript(elsewhere, FILE_ID, turn(FORK, 'u1'))
    const jobDir = join(configDir, 'jobs', FORK.slice(0, 8))
    mkdirSync(jobDir, { recursive: true })
    writeFileSync(
      join(jobDir, 'state.json'),
      JSON.stringify({ sessionId: FORK, linkScanPath: forkPath })
    )

    expect(new ClaudeSessionContinuationTracker().resolve(session(OLD, oldPath))).toBeNull()
  })

  it('follows a chain of forks and stops on a cycle', () => {
    const { projectDir } = makeProject()
    const oldPath = writeTranscript(projectDir, OLD, turn(OLD, 'u1') + pointer(OLD, FORK))
    writeTranscript(projectDir, FORK, turn(FORK, 'u1') + pointer(FORK, SECOND_FORK))
    const secondPath = writeTranscript(
      projectDir,
      SECOND_FORK,
      turn(SECOND_FORK, 'u1') + pointer(SECOND_FORK, OLD)
    )

    expect(new ClaudeSessionContinuationTracker().resolve(session(OLD, oldPath))).toEqual(
      session(SECOND_FORK, secondPath)
    )
  })

  it('follows /clear inside a job through the job state, after the transcripts stop growing', () => {
    const { configDir, projectDir } = makeProject()
    const oldPath = writeTranscript(projectDir, OLD, turn(OLD, 'u1') + pointer(OLD, FORK))
    const forkPath = writeTranscript(projectDir, FORK, turn(FORK, 'u1'))
    writeJobState(configDir, { sessionId: FORK, resumeSessionId: FORK, linkScanPath: forkPath })
    const tracker = new ClaudeSessionContinuationTracker()
    expect(tracker.resolve(session(OLD, oldPath))).toEqual(session(FORK, forkPath))
    expect(tracker.resolve(session(FORK, forkPath))).toBeNull()

    const clearedPath = writeTranscript(projectDir, CLEARED, turn(CLEARED, 'u2'))
    writeJobState(configDir, {
      sessionId: FORK,
      resumeSessionId: CLEARED,
      linkScanPath: clearedPath
    })
    expect(tracker.resolve(session(FORK, forkPath))).toEqual(session(CLEARED, clearedPath))
    expect(tracker.resolve(session(OLD, oldPath))).toEqual(session(CLEARED, clearedPath))

    // A second `/clear`: the job state stays under FORK, so the row on CLEARED must still find it.
    const reclearedPath = writeTranscript(projectDir, SECOND_FORK, turn(SECOND_FORK, 'u3'))
    writeJobState(configDir, {
      sessionId: FORK,
      resumeSessionId: SECOND_FORK,
      linkScanPath: reclearedPath
    })
    expect(tracker.resolve(session(CLEARED, clearedPath))).toEqual(
      session(SECOND_FORK, reclearedPath)
    )
  })

  it.each([
    [
      'names the same session',
      (_dir: string, forkPath: string) => ({ resumeSessionId: FORK, linkScanPath: forkPath })
    ],
    [
      'points outside the project',
      (configDir: string) => {
        const elsewhere = join(configDir, 'projects', '-other-repo')
        mkdirSync(elsewhere, { recursive: true })
        return {
          resumeSessionId: CLEARED,
          linkScanPath: writeTranscript(elsewhere, CLEARED, turn(CLEARED, 'u2'))
        }
      }
    ],
    [
      'points at a file that never names the session',
      (_dir: string, forkPath: string) => ({
        resumeSessionId: CLEARED,
        linkScanPath: writeTranscript(join(forkPath, '..'), CLEARED, turn(SECOND_FORK, 'u2'))
      })
    ]
  ])('ignores a job state that %s', (_label, makeState) => {
    const { configDir, projectDir } = makeProject()
    const forkPath = writeTranscript(projectDir, FORK, turn(FORK, 'u1'))
    writeJobState(configDir, { sessionId: FORK, ...makeState(configDir, forkPath) })

    expect(new ClaudeSessionContinuationTracker().resolve(session(FORK, forkPath))).toBeNull()
  })
})
