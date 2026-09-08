import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { resolveSpawn, runProcess, runProcessSync } from './run-process'
import { WINDOWS_ARGUMENT_CORPUS } from './__fixtures__/windows-argument-corpus'

const SPEC = { program: 'C:\\bin\\agent.cmd', args: ['--prompt', 'hi'] }

describe('resolveSpawn', () => {
  it('always hides the console and never uses a shell', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      const resolved = resolveSpawn({ program: 'git', args: ['status'] }, platform)
      expect(resolved.options.windowsHide).toBe(true)
      expect(resolved.options.shell).toBe(false)
    }
  })

  it('spawns a non-cmd program directly, letting Node do the argv quoting', () => {
    // Node's own Windows quoting is already CommandLineToArgvW-correct for real
    // executables; re-implementing it here would add risk for no gain.
    const resolved = resolveSpawn({ program: 'C:\\bin\\agent.exe', args: ['a b'] }, 'win32')
    expect(resolved.file).toBe('C:\\bin\\agent.exe')
    expect(resolved.args).toEqual(['a b'])
    expect(resolved.options.windowsVerbatimArguments).toBeUndefined()
  })

  it('routes a .cmd target through cmd.exe with a verbatim line', () => {
    const resolved = resolveSpawn({ ...SPEC, env: { ComSpec: 'C:\\W\\cmd.exe' } }, 'win32')
    expect(resolved.file).toBe('C:\\W\\cmd.exe')
    expect(resolved.args).toHaveLength(1)
    expect(resolved.args[0]).toContain('/d /v:off /s /c')
    expect(resolved.options.windowsVerbatimArguments).toBe(true)
    expect(resolved.options.windowsHide).toBe(true)
  })

  it('treats a .cmd path as an ordinary program off Windows', () => {
    // A POSIX host running a file that happens to end in .cmd must not gain a
    // cmd.exe hop; the extension carries no meaning there.
    const resolved = resolveSpawn(SPEC, 'linux')
    expect(resolved.file).toBe(SPEC.program)
    expect(resolved.args).toEqual(SPEC.args)
  })

  it('never lets a corpus argument reach cmd as an operator', () => {
    for (const { name, value } of WINDOWS_ARGUMENT_CORPUS) {
      const line = resolveSpawn({ program: 'C:\\a.cmd', args: [value] }, 'win32').args[0]!
      const body = line.slice('/d /v:off /s /c "'.length, -1)
      // Every `&`/`|`/`<`/`>` must sit inside a quoted run. Walking the parity
      // is the same thing cmd does, so this is the property that matters.
      let quoted = false
      for (const char of body) {
        if (char === '"') {
          quoted = !quoted
          continue
        }
        if ('&|<>'.includes(char)) {
          expect(quoted, `${name}: bare ${char} would parse as a cmd operator`).toBe(true)
        }
      }
      expect(quoted, `${name}: line ends mid-quote`).toBe(false)
    }
  })
})

describe('runProcessSync', () => {
  it('reports a timeout as timedOut', () => {
    const result = runProcessSync({
      program: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 5000)'],
      timeoutMs: 300
    })
    expect(result.timedOut).toBe(true)
  })

  it('does not report a deliberately terminated child as timedOut', () => {
    // Both cases exit on SIGTERM, so reading the signal alone conflates them —
    // and a caller that retries on timeout would then retry a process someone
    // stopped on purpose.
    const result = runProcessSync({
      program: process.execPath,
      args: ['-e', 'process.kill(process.pid, "SIGTERM")'],
      timeoutMs: 30_000
    })
    // Why not assert the signal: Windows has no signals, so the same deliberate
    // kill reports an exit code there and a signal on POSIX. What must hold on
    // both is that neither shape reads as a timeout.
    expect(result.timedOut).toBe(false)
    expect(result.code === 0 && result.signal === null).toBe(false)
  })

  it('captures stdout and the exit code without throwing on failure', () => {
    const result = runProcessSync({
      program: process.execPath,
      args: ['-e', 'process.stdout.write("hi"); process.exit(3)']
    })
    expect(result.stdout).toBe('hi')
    expect(result.code).toBe(3)
  })
})

describe('bounded output', () => {
  it('reports a clipped answer instead of passing it off as the whole one', async () => {
    const result = await runProcess({
      program: process.execPath,
      args: ['-e', 'process.stdout.write("x".repeat(64))'],
      maxOutputBytes: 8
    })
    expect(result.stdout).toBe('xxxxxxxx')
    expect(result.outputTruncated).toBe(true)
  })

  it('does not call output that exactly fills the cap truncated', async () => {
    const result = await runProcess({
      program: process.execPath,
      args: ['-e', 'process.stdout.write("x".repeat(8))'],
      maxOutputBytes: 8
    })
    expect(result.outputTruncated).toBe(false)
  })
})

describe('unkillable children', () => {
  it('settles after the grace period rather than outliving its own deadline', async () => {
    // `close` only fires once the child is gone, so a child that ignores the
    // kill would otherwise hold the promise forever — and callers that cache an
    // in-flight probe would hand every later caller the same dead promise.
    const result = await runProcess({
      program: process.execPath,
      args: ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'],
      timeoutMs: 300
    })
    expect(result.timedOut).toBe(true)
  }, 20_000)
})

describe('abort', () => {
  it('settles after the grace period when an aborted child ignores the signal', async () => {
    // An aborted caller has stopped waiting; an unkillable child must not keep
    // the promise alive on their behalf either.
    const controller = new AbortController()
    const pending = runProcess({
      program: process.execPath,
      args: ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'],
      timeoutMs: 60_000,
      signal: controller.signal
    })
    setTimeout(() => controller.abort(), 300)
    const result = await pending
    // Not a timeout: the caller asked it to stop.
    expect(result.timedOut).toBe(false)
  }, 20_000)

  it.skipIf(process.platform === 'win32')(
    'kills the process group and waits for confirmed root exit with a termination barrier',
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'run-process-barrier-'))
      const marker = path.join(root, 'descendant-state')
      const descendantScript =
        `printf ready > "$1";trap 'printf signaled > "$1"' TERM;` + `while :;do sleep 1;done`
      const controller = new AbortController()
      const pending = runProcess({
        program: process.execPath,
        args: [
          '-e',
          `const {spawn}=require('node:child_process');` +
            `spawn('/bin/sh',${JSON.stringify(['-c', descendantScript, 'sh', marker])},{stdio:'ignore'});` +
            `setInterval(()=>{},1000)`
        ],
        timeoutMs: 60_000,
        signal: controller.signal,
        terminationBarrier: true
      })
      try {
        await expect
          .poll(() => readFile(marker, 'utf8').catch(() => ''), { timeout: 10_000 })
          .toBe('ready')
        controller.abort()
        await pending
        await expect.poll(() => readFile(marker, 'utf8')).toBe('signaled')
      } finally {
        controller.abort()
        await pending
        await rm(root, { recursive: true, force: true })
      }
    },
    30_000
  )
})

describe('stdin delivery failures', () => {
  it('survives a child that exits without reading its input', async () => {
    // The queued write fails with EPIPE, and an unhandled error on a stream is
    // an uncaught exception — it would take the whole main process down.
    const result = await runProcess({
      program: process.execPath,
      args: ['-e', 'process.exit(7)'],
      input: 'x'.repeat(1024 * 1024),
      timeoutMs: 15_000
    })
    expect(result.code).toBe(7)
    expect(result.timedOut).toBe(false)
  }, 20_000)
})

describe('a signal that is already aborted', () => {
  it('stops the child instead of running it to the timeout', async () => {
    // addEventListener never fires for an abort that already happened, so the
    // caller would wait out the full deadline having already given up.
    const controller = new AbortController()
    controller.abort()
    const startedAt = Date.now()
    const onChildTerminated = vi.fn()
    const result = await runProcess({
      program: path.join(tmpdir(), 'orca-must-not-spawn'),
      timeoutMs: 30_000,
      signal: controller.signal,
      onChildTerminated
    })
    expect(result.timedOut).toBe(false)
    expect(onChildTerminated).toHaveBeenCalledOnce()
    expect(Date.now() - startedAt).toBeLessThan(10_000)
  }, 20_000)
})

describe('output truncation', () => {
  const emit = (bytes: number): string =>
    `for (let i = 0; i < ${bytes}; i += 1) process.stderr.write('n'); process.stderr.write('FAILED')`

  it('keeps the head by default', async () => {
    const result = await runProcess({
      program: process.execPath,
      args: ['-e', emit(200)],
      maxOutputBytes: 64
    })
    expect(result.stderr).not.toContain('FAILED')
    expect(result.stderr).toBe('n'.repeat(64))
  })
})
