import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { sendToTerminal } from './terminal'

export type StagedTerminalNodeScript = {
  // Shell-agnostic command without a trailing carriage return.
  command: string
  scriptPath: string
  /** Removes the staged temp file. Only call after the script has started. */
  cleanup: () => void
}

// Stage a .cjs file: PowerShell re-splits node -e JSON quoting at semicolons before the script runs (#8521).
export function stageNodeScriptForTerminal(
  source: string,
  options: { dir?: string; prefix?: string } = {}
): StagedTerminalNodeScript {
  const dir = options.dir ?? tmpdir()
  mkdirSync(dir, { recursive: true })
  const prefix = options.prefix ?? 'orca-e2e-terminal-node'
  const scriptPath = path.join(dir, `${prefix}-${randomUUID()}.cjs`)
  writeFileSync(scriptPath, source)
  // Forward slashes survive PowerShell, cmd and POSIX parsing; raw backslashes do not.
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
