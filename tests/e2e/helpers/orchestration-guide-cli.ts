/**
 * Runs the guide's argv through the COMPILED CLI (`out/cli/index.js`) against a
 * live runtime, and records what it ran for the drift gate.
 *
 * Why the compiled binary and not the handler modules: every existing CLI test
 * mocks the runtime client, so the runtime's own refusal is never produced.
 * #19542 broke exactly there — the params were right and the write threw.
 *
 * `as` sets ORCA_TERMINAL_HANDLE rather than adding `--from`, because that is
 * how the guide's commands run: inside an Orca terminal that resolves the
 * caller. Passing `--from` everywhere would test an argv the guide never prints.
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { expect } from '@stablyai/playwright-test'
import type { GuideCommandLedger } from './orchestration-guide-command-ledger'

export type CliRun = { args: string[]; status: number | null; stdout: string; stderr: string }
export type OrchestrationCli = (as: string | null, args: string[]) => CliRun

export const COMPILED_CLI_ENTRY = path.join(process.cwd(), 'out', 'cli', 'index.js')

export function createOrchestrationCli(
  userDataDir: string,
  ledger: GuideCommandLedger
): OrchestrationCli {
  return (as, args) => {
    ledger.record(args)
    // Strip an inherited handle so identity comes from `as` alone, never from the shell that ran the suite.
    const { ORCA_TERMINAL_HANDLE: _inherited, ...cleanEnv } = process.env
    void _inherited
    const result = spawnSync(process.execPath, [COMPILED_CLI_ENTRY, ...args], {
      env: {
        ...cleanEnv,
        ORCA_USER_DATA_PATH: userDataDir,
        ORCA_DEV_CLI_INVOCATION: '1',
        ...(as ? { ORCA_TERMINAL_HANDLE: as } : {})
      },
      encoding: 'utf8',
      timeout: 120_000
    })
    return { args, status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  }
}

export function describeRun(run: CliRun): string {
  return `orca ${run.args.join(' ')}\nexit=${run.status}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`
}

/** The `{ok, result}` envelope, without asserting the exit code. */
export function payload<T>(run: CliRun): T {
  const parsed = JSON.parse(run.stdout) as { ok: boolean; result: T }
  expect(parsed.ok, describeRun(run)).toBe(true)
  return parsed.result
}

export function receipt<T>(run: CliRun): T {
  expect(run.status, describeRun(run)).toBe(0)
  return payload<T>(run)
}
