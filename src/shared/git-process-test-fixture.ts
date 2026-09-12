import { runProcess, type ProcessResult } from './child-process/run-process'

function gitFailure(args: readonly string[], result: ProcessResult): Error {
  const detail = result.timedOut
    ? 'timed out'
    : result.stderr.trim() || `exited with ${result.code ?? 'no exit code'}`
  return new Error(`git ${args.join(' ')} ${detail}`)
}

export async function runGitFixture(cwd: string, args: readonly string[]): Promise<string> {
  const result = await runProcess({ program: 'git', args, cwd })
  if (result.code !== 0 || result.timedOut) {
    throw gitFailure(args, result)
  }
  return result.stdout
}
