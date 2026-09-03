import { execFileSync } from 'node:child_process'

export function runGit(repoPath: string, args: string[]): void {
  execFileSync('git', args, { cwd: repoPath, stdio: 'pipe' })
}
