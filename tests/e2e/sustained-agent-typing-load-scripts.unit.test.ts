import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { runProcess } from '../../src/shared/child-process/run-process'
import { writeSustainedAgentLoadScript } from './sustained-agent-typing-load-scripts'

it('paces the generated Unicode stream in bytes without splitting UTF-8 characters', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'orca-typing-stream-test-'))
  try {
    const script = path.join(directory, 'load.mjs')
    writeSustainedAgentLoadScript(script, 'rate-test', directory)
    const result = await runProcess({
      program: process.execPath,
      args: [script, '0', '4', '2', '0'],
      timeoutMs: 10_000
    })
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toContain('MWT_LOAD_DONE_rate-test_0')
    expect(result.stdout).not.toContain('\uFFFD')
    // Readiness/completion control sequences are outside the stream-byte budget.
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(4 * 1024 * 2 + 512)
    // Lower bound too: without it a generator that emits no stream bytes still passes.
    expect(Buffer.byteLength(result.stdout)).toBeGreaterThan(4 * 1024 * 2 * 0.8)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}, 15_000)
