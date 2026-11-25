import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { afterEach, describe, expect, it } from 'vitest'
import { encodeMcpEnvPairs, mcpEnvWrapperCommand } from './mcp-env-pairs'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** A stand-in for the guest's `orca` that answers `mcp env` with `answer`, as the real one would. */
function fakeOrca(answer: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-env-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'answer'), answer)
  const launcher = join(dir, 'orca')
  // Like the interop bridge, it would read whatever stdin it's given before answering.
  writeFileSync(
    launcher,
    `#!/bin/sh\nprintf '%s\\n' "$@" > '${join(dir, 'args')}'\ncat >/dev/null\ncat '${join(dir, 'answer')}'\n`
  )
  chmodSync(launcher, 0o755)
  return launcher
}

async function runWrapped(
  launcher: string,
  input = '',
  workspaceId: string | null = 'repo-1::/r'
): Promise<{ code: number | null; stdout: string }> {
  const { command, args } = mcpEnvWrapperCommand(
    { launcher, id: 'id-pg-000001', agent: 'claude', workspaceId },
    // The server: prints the env values it was started with.
    {
      command: 'bash',
      args: ['-c', 'printf "%s|" "$DATABASE_URL" "$NOTE" "$EMPTY" "$p" "$e" "$(cat)"']
    }
  )
  const result = await runProcess({ program: command, args, input, timeoutMs: 10_000 })
  return { code: result.code, stdout: result.stdout }
}

// The wrapper runs in a WSL guest; bash is there, and on the macOS and Linux runners.
describe.skipIf(process.platform === 'win32')(
  'a WSL server’s saved env through orca mcp env',
  () => {
    it('reaches the server intact, whatever the values hold', async () => {
      const env = {
        DATABASE_URL: "postgres://app:p@ss 'w\"rd'$HOME\\x@db/prod",
        NOTE: 'two\nlines = here',
        EMPTY: '',
        // Names a reader loop could use for itself.
        p: 'saved-p',
        e: 'saved-e'
      }
      // The agent's first request is already in the pipe when the wrapper starts.
      const initialize = '{"jsonrpc":"2.0","id":1,"method":"initialize"}'
      const { code, stdout } = await runWrapped(fakeOrca(encodeMcpEnvPairs(env)), initialize)
      expect(code).toBe(0)
      expect(stdout).toBe(`${env.DATABASE_URL}|${env.NOTE}||saved-p|saved-e|${initialize}|`)
    })

    it('starts nothing from a cut-off answer', async () => {
      const whole = encodeMcpEnvPairs({ DATABASE_URL: 'postgres://db' })
      const { code, stdout } = await runWrapped(fakeOrca(whole.slice(0, whole.indexOf('ORCA'))))
      expect(code).toBe(1)
      expect(stdout).toBe('')
    })

    it('names the workspace the launch chose the server by, or that it chose by none', async () => {
      const launcher = fakeOrca(encodeMcpEnvPairs({}))
      const argsOf = (): string[] =>
        readFileSync(join(dirname(launcher), 'args'), 'utf8')
          .trim()
          .split('\n')
      await runWrapped(launcher)
      expect(argsOf()).toEqual([
        'mcp',
        'env',
        'id-pg-000001',
        '--agent',
        'claude',
        '--workspace',
        'repo-1::/r'
      ])
      await runWrapped(launcher, '', null)
      expect(argsOf()).toEqual([
        'mcp',
        'env',
        'id-pg-000001',
        '--agent',
        'claude',
        '--outside-workspace'
      ])
    })
  }
)
