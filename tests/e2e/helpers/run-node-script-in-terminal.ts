import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { sendToTerminal } from './terminal'

export type StagedTerminalNodeScript = {
  /**
   * Shell-agnostic command (no trailing `\r`): `node "<forward-slash path>"`.
   */
  command: string
  scriptPath: string
  /** Removes the staged temp file. Only call after the script has started. */
  cleanup: () => void
}

// Why: `node -e ${JSON.stringify(script)}` breaks under PowerShell PTYs on
// Windows — PowerShell does not honor \" escapes, so it re-splits the program
// on `;` and node throws before emitting the payload (#8521). Staging the
// program in a temp .cjs file removes shell quoting from the picture entirely
// while emitting byte-identical output on every shell.
export function stageNodeScriptForTerminal(
  source: string,
  options: { dir?: string; prefix?: string } = {}
): StagedTerminalNodeScript {
  const dir = options.dir ?? tmpdir()
  mkdirSync(dir, { recursive: true })
  const prefix = options.prefix ?? 'orca-e2e-terminal-node'
  const scriptPath = path.join(dir, `${prefix}-${randomUUID()}.cjs`)
  writeFileSync(scriptPath, source)
  // Why: forward slashes are valid for node on Windows and parse identically in
  // PowerShell, cmd, and POSIX shells; raw backslashes would be eaten by bash.
  const command = `node "${scriptPath.replaceAll('\\', '/')}"`
  return {
    command,
    scriptPath,
    cleanup: () => rmSync(scriptPath, { force: true })
  }
}

export async function runNodeScriptInTerminal(
  page: Page,
  ptyId: string,
  source: string,
  options: { dir?: string; prefix?: string } = {}
): Promise<StagedTerminalNodeScript> {
  const staged = stageNodeScriptForTerminal(source, options)
  await sendToTerminal(page, ptyId, `${staged.command}\r`)
  return staged
}
