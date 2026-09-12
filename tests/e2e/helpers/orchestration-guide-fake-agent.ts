/**
 * A codex stand-in on PATH for the guide-contract spec.
 *
 * It ACKs the injected preamble the way a real TUI does (bracketed paste, then a
 * submit) and records every stdin chunk under the handle it was launched as.
 * That recording is what makes the Dispatch capability observable: the spec
 * reads the capability the worker really received in its preamble rather than
 * asking an RPC for one, which is the same substitution the worker contract
 * forbids.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildFakeAgentCommandOverride } from './fake-agent-command-override'
import { FAKE_AGENT_PASTE_END_SCANNER_SOURCE } from './fake-agent-paste-end-scanner'

export type GuideContractFakeAgent = {
  /** Value for `agentCmdOverrides.codex`, and the argv for a low-level `terminal.create`. */
  command: string
  /** Every fake agent appends here; the launch env must carry it as ORCA_E2E_GUIDE_STDIN. */
  stdinLedgerPath: string
  /** Everything the pane owned by `handle` has been sent, concatenated. */
  readStdin: (handle: string) => string
  reset: () => void
  cleanup: () => void
}

const AGENT_SOURCE = `
const { appendFileSync } = require('node:fs')
if (process.argv.slice(2).includes('app-server')) {
  process.stderr.write("error: unrecognized subcommand 'app-server'\\n")
  process.exit(2)
}
${FAKE_AGENT_PASTE_END_SCANNER_SOURCE}
process.stdout.write('\\u001b]0;Codex Ready\\u0007OpenAI Codex\\nmodel: e2e\\ndirectory: e2e\\n')
process.stdin.on('data', (chunk) => {
  const input = chunk.toString()
  try {
    appendFileSync(
      process.env.ORCA_E2E_GUIDE_STDIN,
      JSON.stringify({ handle: process.env.ORCA_TERMINAL_HANDLE || null, input }) + '\\n'
    )
  } catch {}
  const scan = scanFakeAgentPasteEnd(fakeAgentPasteEndTail, input)
  fakeAgentPasteEndTail = scan.tail
  if (scan.pasteEndOffset !== null) {
    process.stdout.write('\\x1b[?25h')
  }
  fakeAgentMaybeAck(scan, input, () => {
    process.stdout.write('\\u001b]0;Codex Working\\u0007ACK\\n')
    setTimeout(() => process.stdout.write('\\u001b]0;Codex Ready\\u0007'), 10)
  })
})
process.stdin.setRawMode?.(true)
process.stdin.resume()
setInterval(() => {}, 60_000)
`

export function createGuideContractFakeAgent(): GuideContractFakeAgent {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-guide-contract-'))
  const stdinLedgerPath = path.join(dir, 'agent-stdin.jsonl')
  const executable = path.join(dir, process.platform === 'win32' ? 'codex.cmd' : 'codex')

  if (process.platform === 'win32') {
    writeFileSync(path.join(dir, 'fake-codex.js'), AGENT_SOURCE)
    writeFileSync(executable, '@echo off\r\nnode "%~dp0\\fake-codex.js" %*\r\n')
  } else {
    writeFileSync(executable, `#!/usr/bin/env node\n${AGENT_SOURCE}`)
    chmodSync(executable, 0o755)
  }

  return {
    command: buildFakeAgentCommandOverride(executable),
    stdinLedgerPath,
    readStdin: (handle) => {
      if (!existsSync(stdinLedgerPath)) {
        return ''
      }
      return readFileSync(stdinLedgerPath, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { handle: string | null; input: string })
        .filter((entry) => entry.handle === handle)
        .map((entry) => entry.input)
        .join('')
    },
    reset: () => rmSync(stdinLedgerPath, { force: true }),
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  }
}

/** Prepended to PATH so `worker-start --agent codex` and `terminal.create` both find it. */
export function fakeAgentLaunchEnv(agent: GuideContractFakeAgent): Record<string, string> {
  return {
    PATH: `${path.dirname(agent.stdinLedgerPath)}${path.delimiter}${process.env.PATH ?? ''}`,
    ORCA_E2E_GUIDE_STDIN: agent.stdinLedgerPath
  }
}
