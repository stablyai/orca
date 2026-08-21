import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type NestedRuntimeProxyJumpFixture = {
  configPath: string
  directory: string
  wrapperPath: string
  dispose(): void
  writeConfig(contents: string): void
}

export function createNestedRuntimeProxyJumpFixture(): NestedRuntimeProxyJumpFixture {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-proxy-jump-'))
  const configPath = path.join(directory, 'ssh-config')
  const wrapperPath = path.join(directory, 'ssh')
  try {
    // Why: OpenSSH ignores an overridden HOME on macOS, so force the disposable HUB-only config explicitly.
    writeFileSync(wrapperPath, `#!/bin/sh\nexec /usr/bin/ssh -F "${configPath}" "$@"\n`, {
      mode: 0o700
    })
    chmodSync(wrapperPath, 0o700)
  } catch (error) {
    rmSync(directory, { force: true, recursive: true })
    throw error
  }
  return {
    configPath,
    directory,
    wrapperPath,
    dispose: () => rmSync(directory, { force: true, recursive: true }),
    writeConfig: (contents) => writeFileSync(configPath, contents, { mode: 0o600 })
  }
}
