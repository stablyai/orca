import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ClaudeSessionContinuationTracker } from './claude-session-continuation'

const OLD = '11111111-1111-4111-8111-111111111111'
const FORK = '22222222-2222-4222-8222-222222222222'
const SECOND_FORK = '33333333-3333-4333-8333-333333333333'
const CLEARED = '44444444-4444-4444-8444-444444444444'

const createdDirs: string[] = []

afterEach(() => {
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

function session(id: string, transcriptPath: string) {
  return { key: 'session_id' as const, id, transcriptPath }
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

  it('retries a pointer whose fork reaches disk after the first check', () => {
    const { projectDir } = makeProject()
    const oldPath = writeTranscript(projectDir, OLD, turn(OLD, 'u1') + pointer(OLD, FORK))
    const tracker = new ClaudeSessionContinuationTracker()
    expect(tracker.resolve(session(OLD, oldPath))).toBeNull()

    const forkPath = writeTranscript(projectDir, FORK, turn(FORK, 'u1'))
    expect(tracker.resolve(session(OLD, oldPath))).toEqual(session(FORK, forkPath))
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

  it('reads only the tail of a transcript larger than the first scan', () => {
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
    const forkPath = writeTranscript(projectDir, 'transcript-file-uuid', turn(FORK, 'u1'))
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
    const forkPath = writeTranscript(elsewhere, 'transcript-file-uuid', turn(FORK, 'u1'))
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
