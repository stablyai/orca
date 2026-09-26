import { accessSync, chmodSync, constants, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export type FakeClaudeInvocation = { argv: string[]; pid: number; cwd: string }

export type FakeClaudeCli = {
  binDir: string
  /** PATH with the fake first and every directory holding another `claude` removed. */
  searchPath: string
  invocations: () => FakeClaudeInvocation[]
  /** Invocations other than the `--help` / `--version` capability probes. */
  launches: () => FakeClaudeInvocation[]
}

const FAKE_CLAUDE_SOURCE = `
import { appendFileSync } from 'node:fs'
const argv = process.argv.slice(2)
appendFileSync(LEDGER, JSON.stringify({ argv, pid: process.pid, cwd: process.cwd() }) + '\\n')
if (argv.includes('--version')) {
  process.stdout.write('9.9.9 (Claude Code)\\n')
  process.exit(0)
}
if (argv.includes('--help')) {
  process.stdout.write('Usage: claude [options] [prompt]\\n  -r, --resume [value]  Resume a conversation\\n  --append-system-prompt <prompt>  Append a system prompt to the default system prompt\\n')
  process.exit(0)
}
process.stdout.write('fake claude ' + argv.join(' ') + '\\r\\n')
process.stdin.resume()
setInterval(() => {}, 1 << 30)
`

function holdsClaude(dir: string): boolean {
  try {
    accessSync(path.join(dir, 'claude'), constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function createFakeClaudeCli(dir: string, inheritedPath: string): FakeClaudeCli {
  const binDir = path.join(dir, 'bin')
  mkdirSync(binDir, { recursive: true })
  const ledger = path.join(dir, 'invocations.jsonl')
  writeFileSync(ledger, '')
  const programPath = path.join(binDir, 'claude')
  // Why a sibling .mjs: the shebang file has no extension, so Node would load it as CommonJS.
  writeFileSync(
    programPath,
    `#!${process.execPath}\nimport(${JSON.stringify(path.join(dir, 'claude.mjs'))})\n`
  )
  writeFileSync(
    path.join(dir, 'claude.mjs'),
    `const LEDGER = ${JSON.stringify(ledger)}\n${FAKE_CLAUDE_SOURCE}`
  )
  chmodSync(programPath, 0o755)
  const invocations = (): FakeClaudeInvocation[] =>
    readFileSync(ledger, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as FakeClaudeInvocation)
  return {
    binDir,
    searchPath: [
      binDir,
      ...inheritedPath.split(path.delimiter).filter((d) => !holdsClaude(d))
    ].join(path.delimiter),
    invocations,
    launches: () =>
      invocations().filter(
        (invocation) =>
          !invocation.argv.includes('--help') && !invocation.argv.includes('--version')
      )
  }
}
