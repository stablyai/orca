import { describe, expect, it } from 'vitest'
import { writeRuntimeTerminalArtifactFile } from './runtime-terminal-artifact-write'
import {
  runtimeEnvironmentCall,
  installRuntimeFileClientEnvironment
} from '../runtime-file-client-test-harness'
import { getDiskBaselineSignature } from '../../../../../shared/file-write/disk-baseline-signature'

installRuntimeFileClientEnvironment()

const PATH = '/private/tmp/handoff.md'
const meta = { runtimeId: 'remote-runtime' }
const ok = (result: unknown) => ({ id: 'rpc', ok: true, result, _meta: meta })
const read = (content: string) =>
  ok({ worktree: 'wt-1', relativePath: PATH, content, truncated: false, byteLength: 1 })

function save(content: string, baseline: string, onGrantRenewed?: (grantId: string) => void) {
  return writeRuntimeTerminalArtifactFile({
    target: { kind: 'environment', environmentId: 'env-1' },
    worktreeId: 'wt-1',
    absolutePath: PATH,
    grantId: 'g-1',
    content,
    precondition: { expectedSignature: getDiskBaselineSignature(baseline), allowMissing: false },
    onGrantRenewed
  })
}

describe('saving a granted host file outside every workspace', () => {
  // Why: desktop delivers a lost reply as a runtime_timeout envelope, not a thrown transport error.
  it('reads back after a desktop timeout envelope and still rejects when the old text remains', async () => {
    const timedOut = {
      id: 'rpc',
      ok: false,
      error: { code: 'runtime_timeout', message: 'Timed out waiting for the remote Orca runtime' },
      _meta: meta
    }
    runtimeEnvironmentCall.mockImplementation(async ({ method }) =>
      method === 'files.writeTerminalArtifact' ? timedOut : read('# old')
    )
    await expect(save('# new', '# old')).rejects.toThrow('Timed out')

    let calls = 0
    runtimeEnvironmentCall.mockImplementation(async ({ method }) => {
      if (method === 'files.writeTerminalArtifact') {
        calls += 1
        return timedOut
      }
      return read(calls > 0 ? '# new' : '# old')
    })
    await expect(save('# new', '# old')).resolves.toEqual({ ok: true })
  })
})
