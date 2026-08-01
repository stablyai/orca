import { describe, expect, it } from 'vitest'

import {
  buildCodexBackfillGateWrapper,
  CODEX_BACKFILL_GATE_WRAPPER_DEADLINE_S,
  ORCA_BACKFILL_GATED_COMMAND_ENV,
  ORCA_BACKFILL_RELEASE_FILE_ENV,
  resolveCodexBackfillGateShellPlatform
} from './codex-backfill-gate-wrapper'

describe('buildCodexBackfillGateWrapper', () => {
  const baseParams = {
    originalCommand: 'codex resume abc',
    codexHomePath: '/home/user/.codex',
    shellPlatform: 'posix' as const
  }

  it('builds a single-line posix wrapper that evals the gated command env', () => {
    const wrapper = buildCodexBackfillGateWrapper(baseParams)

    expect(wrapper.command).not.toContain('\n')
    // Why: the wrapper is typed into the pane's OWN interactive shell, which may be fish/nushell/
    // dash; only a `bash -lc '<script>'` envelope (one quoted command word, no embedded quotes)
    // parses in all of them — a bare bash poll loop is a fail-closed parse error on fish/nu.
    expect(wrapper.command).toMatch(/^bash -lc '[^']*'$/)
    expect(wrapper.command).toContain(
      `deadline=$((SECONDS+${CODEX_BACKFILL_GATE_WRAPPER_DEADLINE_S}))`
    )
    expect(wrapper.command).toContain(`[ ! -e "$${ORCA_BACKFILL_RELEASE_FILE_ENV}" ]`)
    expect(wrapper.command).toContain(`rm -f -- "$${ORCA_BACKFILL_RELEASE_FILE_ENV}" 2>/dev/null`)
    expect(wrapper.command).toContain(`eval " $${ORCA_BACKFILL_GATED_COMMAND_ENV}"`)
    // Why: fail-open divergence from the setup wrapper — deadline expiry must still run the command.
    expect(wrapper.command).not.toContain('exit 124')
  })

  it('round-trips a command with single quotes and newlines verbatim through env', () => {
    const originalCommand = "codex 'fix bug'\nprintf 'done\\n'"
    const wrapper = buildCodexBackfillGateWrapper({ ...baseParams, originalCommand })

    expect(wrapper.env[ORCA_BACKFILL_GATED_COMMAND_ENV]).toBe(originalCommand)
  })

  it('places the release sentinel under <home>/.orca/ with a unique nonce per call', () => {
    const first = buildCodexBackfillGateWrapper(baseParams)
    const second = buildCodexBackfillGateWrapper(baseParams)

    expect(first.releaseFilePath).toMatch(/^\/home\/user\/\.codex\/\.orca\/backfill-release-.+$/)
    expect(second.releaseFilePath).toMatch(/^\/home\/user\/\.codex\/\.orca\/backfill-release-.+$/)
    expect(second.releaseFilePath).not.toBe(first.releaseFilePath)
  })

  it('applies toShellViewPath to the env value but keeps the host view in releaseFilePath', () => {
    const wrapper = buildCodexBackfillGateWrapper({
      ...baseParams,
      toShellViewPath: (hostPath) => `/mnt/shell-view${hostPath}`
    })

    expect(wrapper.env[ORCA_BACKFILL_RELEASE_FILE_ENV]).toBe(
      `/mnt/shell-view${wrapper.releaseFilePath}`
    )
    expect(wrapper.releaseFilePath).toMatch(/^\/home\/user\/\.codex\/\.orca\/backfill-release-/)
  })

  it('builds a win32 -EncodedCommand wrapper that polls Test-Path and fails open into Invoke-Expression', () => {
    const wrapper = buildCodexBackfillGateWrapper({
      ...baseParams,
      codexHomePath: 'C:\\Users\\user\\.codex',
      shellPlatform: 'win32'
    })

    expect(wrapper.command).toMatch(
      /^powershell\.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand [A-Za-z0-9+/=]+$/
    )
    expect(
      wrapper.releaseFilePath.startsWith('C:\\Users\\user\\.codex\\.orca\\backfill-release-')
    ).toBe(true)

    const script = decodePowerShellScript(wrapper.command)
    expect(script).toContain('Test-Path -LiteralPath $release')
    expect(script).toContain(`AddSeconds(${CODEX_BACKFILL_GATE_WRAPPER_DEADLINE_S})`)
    expect(script).toContain('Remove-Item -LiteralPath $release')
    expect(script).toContain(`Invoke-Expression $env:${ORCA_BACKFILL_GATED_COMMAND_ENV}`)
    // Why: fail-open divergence from the setup wrapper — no fail-closed timeout exit.
    expect(script).not.toContain('exit 124')
  })
})

describe('resolveCodexBackfillGateShellPlatform', () => {
  it('resolves the wrapper flavor from the pane shell, not the host platform', () => {
    expect(resolveCodexBackfillGateShellPlatform({ hostPlatform: 'win32', paneIsWsl: false })).toBe(
      'win32'
    )
    expect(resolveCodexBackfillGateShellPlatform({ hostPlatform: 'win32', paneIsWsl: true })).toBe(
      'posix'
    )
    expect(resolveCodexBackfillGateShellPlatform({ hostPlatform: 'linux', paneIsWsl: false })).toBe(
      'posix'
    )
    expect(
      resolveCodexBackfillGateShellPlatform({ hostPlatform: 'darwin', paneIsWsl: false })
    ).toBe('posix')
  })
})

function decodePowerShellScript(command: string): string {
  const encoded = command.match(/-EncodedCommand\s+([A-Za-z0-9+/=]+)/)?.[1]
  if (!encoded) {
    throw new Error('Missing PowerShell encoded command')
  }
  return Buffer.from(encoded, 'base64').toString('utf16le')
}
