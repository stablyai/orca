import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  sanitizeTerminalSplitLatencyReport,
  writeTerminalSplitLatencyArtifact
} from './terminal-split-activation-latency-artifact'

const temporaryDirectories: string[] = []

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop()
    if (directory) {
      rmSync(directory, { recursive: true, force: true })
    }
  }
})

describe('writeTerminalSplitLatencyArtifact', () => {
  it('writes the report body to the requested path', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-split-latency-artifact-'))
    temporaryDirectories.push(directory)
    const outputPath = join(directory, 'report.json')
    const body = '{"status":"passed"}\n'

    writeTerminalSplitLatencyArtifact(outputPath, body)

    expect(existsSync(outputPath)).toBe(true)
    expect(readFileSync(outputPath, 'utf8')).toBe(body)
  })

  it('throws when the report path cannot be written', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-split-latency-artifact-'))
    temporaryDirectories.push(directory)
    const outputPath = join(directory, 'missing-parent', 'report.json')

    expect(() => writeTerminalSplitLatencyArtifact(outputPath, '{}')).toThrow(
      `[terminal-split-activation-latency] unable to write ${outputPath}`
    )
  })
})

describe('sanitizeTerminalSplitLatencyReport', () => {
  it('replaces the machine-local test repo path', () => {
    expect(
      sanitizeTerminalSplitLatencyReport({ testRepoPath: '/var/folders/ab/T/orca-seeded-repo' })
        .testRepoPath
    ).toBe('<test-repo>')
  })

  it('redacts absolute paths and bounds free-form cleanup text', () => {
    const sanitized = sanitizeTerminalSplitLatencyReport({
      abortReason: 'ENOENT: /Users/someone/secret/dir missing',
      measuredSamples: [{ shortcutToFocusMs: 12, cleanupError: `x /tmp/a ${'y'.repeat(500)}` }]
    })

    expect(sanitized.abortReason).toBe('ENOENT: <path> missing')
    const [sample] = sanitized.measuredSamples as { cleanupError: string }[]
    expect(sample?.cleanupError).not.toContain('/tmp/a')
    expect(sample?.cleanupError.length).toBeLessThanOrEqual(200)
  })

  it('keeps timing fields and non-string cleanup values intact', () => {
    const sanitized = sanitizeTerminalSplitLatencyReport({
      headlineMs: { shortcutToFocusP50: 12 },
      measuredSamples: [{ shortcutToFocusMs: 12, cleanupError: null }]
    })

    expect(sanitized.headlineMs).toEqual({ shortcutToFocusP50: 12 })
    expect(sanitized.measuredSamples).toEqual([{ shortcutToFocusMs: 12, cleanupError: null }])
  })
})
