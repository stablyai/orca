import { encodePowerShellCommand } from './powershell-command-encoding'

export const ORCA_BACKFILL_GATED_COMMAND_ENV = 'ORCA_BACKFILL_GATED_COMMAND'
export const ORCA_BACKFILL_RELEASE_FILE_ENV = 'ORCA_BACKFILL_RELEASE_FILE'
// Why: second fail-open net if main dies mid-hold; must exceed main's 15-minute release ceiling.
export const CODEX_BACKFILL_GATE_WRAPPER_DEADLINE_S = 20 * 60

export type CodexBackfillGateWrapper = {
  command: string // replaces spawnOptions.command
  env: Record<string, string> // merge into the spawn env (both env vars above)
  releaseFilePath: string // HOST-view path main touches at release
}

/** Why: the wrapper flavor follows the PANE's shell, never the host platform — a win32-host WSL pane runs
 * bash, so a PowerShell wrapper could neither read the gated-command env across the WSL boundary nor
 * Test-Path a distro-visible sentinel (hooks.ts precedent: WSL worktrees are Linux fs on a win32 host). */
export function resolveCodexBackfillGateShellPlatform(params: {
  hostPlatform: string // pass process.platform
  paneIsWsl: boolean
}): 'posix' | 'win32' {
  return params.hostPlatform === 'win32' && !params.paneIsWsl ? 'win32' : 'posix'
}

/** Why: deliver the held codex command through the production-proven startup path (argv/-EncodedCommand/
 * shell-ready) instead of a raw deferred pty write, which testing proved lossy/garbled (#11828). */
export function buildCodexBackfillGateWrapper(params: {
  originalCommand: string
  codexHomePath: string // gate home; sentinel lives at <home>/.orca/backfill-release-<nonce>
  shellPlatform: 'posix' | 'win32'
  toShellViewPath?: (hostPath: string) => string // WSL translation; default identity
}): CodexBackfillGateWrapper {
  const toShellViewPath = params.toShellViewPath ?? ((hostPath: string): string => hostPath)
  // Why: follow the home path's own separator so native Windows and WSL UNC homes both stay well-formed.
  const separator = params.codexHomePath.includes('\\') ? '\\' : '/'
  const releaseFilePath = [
    params.codexHomePath,
    '.orca',
    `backfill-release-${createReleaseNonce()}`
  ].join(separator)

  return {
    command: params.shellPlatform === 'win32' ? buildWin32GateCommand() : buildPosixGateCommand(),
    env: {
      [ORCA_BACKFILL_GATED_COMMAND_ENV]: params.originalCommand,
      [ORCA_BACKFILL_RELEASE_FILE_ENV]: toShellViewPath(releaseFilePath)
    },
    releaseFilePath
  }
}

// Why: the PTY launch path feeds this through an interactive shell; one line avoids `quote>` prompts.
function buildPosixGateCommand(): string {
  return [
    `deadline=$((SECONDS+${CODEX_BACKFILL_GATE_WRAPPER_DEADLINE_S}));`,
    `while [ ! -e "$${ORCA_BACKFILL_RELEASE_FILE_ENV}" ] && [ "$SECONDS" -lt "$deadline" ]; do sleep 1; done;`,
    // Why: fail open — on deadline expiry the held command still runs; never the setup wrapper's exit 124.
    `rm -f -- "$${ORCA_BACKFILL_RELEASE_FILE_ENV}" 2>/dev/null;`,
    `eval " $${ORCA_BACKFILL_GATED_COMMAND_ENV}"`
  ].join(' ')
}

function buildWin32GateCommand(): string {
  const script = [
    `$release = $env:${ORCA_BACKFILL_RELEASE_FILE_ENV}`,
    `$deadline = (Get-Date).AddSeconds(${CODEX_BACKFILL_GATE_WRAPPER_DEADLINE_S})`,
    'while ($true) {',
    '  if (Test-Path -LiteralPath $release) { break }',
    // Why: fail open — deadline expiry breaks into the eval; never the setup wrapper's exit 124.
    '  if ((Get-Date) -ge $deadline) { break }',
    '  Start-Sleep -Seconds 1',
    '}',
    'Remove-Item -LiteralPath $release -Force -ErrorAction SilentlyContinue',
    `Invoke-Expression $env:${ORCA_BACKFILL_GATED_COMMAND_ENV}`,
    'if ($global:LASTEXITCODE -ne $null) { exit $global:LASTEXITCODE }',
    'if (-not $?) { exit 1 }',
    'exit 0'
  ].join('; ')

  return `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encodePowerShellCommand(script)}`
}

// Why: overlapping gated launches against one codex home must not race on a shared sentinel.
function createReleaseNonce(): string {
  const cryptoApi = globalThis.crypto
  if (typeof cryptoApi?.randomUUID === 'function') {
    return cryptoApi.randomUUID()
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}
