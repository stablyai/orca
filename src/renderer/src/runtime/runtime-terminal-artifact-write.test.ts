import { describe, expect, it, vi } from 'vitest'
import { writeRuntimeTerminalArtifactFile } from './runtime-terminal-artifact-write'
import {
  fsWriteFile,
  runtimeEnvironmentCall,
  installRuntimeFileClientEnvironment,
  type RuntimeRpcRequest
} from './runtime-file-client-test-harness'
import { getDiskBaselineSignature } from '../../../shared/disk-baseline-signature'
import { replaceRuntimeEnvironmentRevisions } from './runtime-environment-revision'

installRuntimeFileClientEnvironment()

const PATH = '/private/tmp/handoff.md'
const meta = { runtimeId: 'remote-runtime' }
const ok = (result: unknown) => ({ id: 'rpc', ok: true, result, _meta: meta })
const refused = (message: string) => ({
  id: 'rpc',
  ok: false,
  error: { code: 'runtime_error', message },
  _meta: meta
})
const read = (content: string) =>
  ok({ worktree: 'wt-1', relativePath: PATH, content, truncated: false, byteLength: 1 })
const granted = (grantId: string) =>
  ok({
    worktree: 'wt-1',
    relativePath: null,
    absolutePath: PATH,
    exists: true,
    isDirectory: false,
    openTarget: { kind: 'absolute-file', provider: 'local', absolutePath: PATH, grantId }
  })

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

function grantIdOf(params: unknown): string | undefined {
  return typeof params === 'object' && params !== null && 'grantId' in params
    ? String(params.grantId)
    : undefined
}

function callsTo(method: string): RuntimeRpcRequest[] {
  return runtimeEnvironmentCall.mock.calls.map(([call]) => call).filter((c) => c.method === method)
}

describe('saving a granted host file outside every workspace', () => {
  it('writes through the grant when the host still holds the opened text', async () => {
    runtimeEnvironmentCall.mockImplementation(async ({ method }) =>
      method === 'files.readTerminalArtifact' ? read('# old') : ok({ ok: true })
    )

    await expect(save('# new', '# old')).resolves.toEqual({ ok: true })

    expect(callsTo('files.writeTerminalArtifact')[0]?.params).toEqual({
      worktree: 'id:wt-1',
      grantId: 'g-1',
      absolutePath: PATH,
      content: '# new'
    })
    // Why: a host path must never become a write of this computer's same path.
    expect(fsWriteFile).not.toHaveBeenCalled()
  })

  it('refuses to overwrite text that changed on the host', async () => {
    runtimeEnvironmentCall.mockImplementation(async ({ method }) =>
      method === 'files.readTerminalArtifact' ? read('# theirs') : ok({ ok: true })
    )

    await expect(save('# new', '# old')).resolves.toEqual({ ok: false, diskConflict: 'changed' })
    expect(callsTo('files.writeTerminalArtifact')).toHaveLength(0)
  })

  it('renews an expired grant and still checks the host text first', async () => {
    runtimeEnvironmentCall.mockImplementation(async ({ method, params }) => {
      if (method === 'files.resolveTerminalPath') {
        return granted('g-2')
      }
      const grantId = grantIdOf(params)
      if (grantId === 'g-1') {
        return refused('terminal_file_grant_expired')
      }
      return method === 'files.readTerminalArtifact' ? read('# old') : ok({ ok: true })
    })

    const onGrantRenewed = vi.fn()
    await expect(save('# new', '# old', onGrantRenewed)).resolves.toEqual({ ok: true })

    expect(onGrantRenewed).toHaveBeenCalledWith('g-2')
    expect(callsTo('files.resolveTerminalPath')[0]?.params).toEqual({
      worktree: 'id:wt-1',
      pathText: PATH
    })
    expect(callsTo('files.writeTerminalArtifact').map((c) => c.params)).toEqual([
      expect.objectContaining({ grantId: 'g-2', content: '# new' })
    ])
  })

  // Why: a host change stales the grant; the renewed read must still raise the conflict banner.
  it('reports a host-side change behind a stale grant as a conflict', async () => {
    runtimeEnvironmentCall.mockImplementation(async ({ method, params }) => {
      if (method === 'files.resolveTerminalPath') {
        return granted('g-2')
      }
      if (grantIdOf(params) === 'g-1') {
        return refused('terminal_file_grant_stale')
      }
      return method === 'files.readTerminalArtifact' ? read('# theirs') : ok({ ok: true })
    })

    await expect(save('# new', '# old')).resolves.toEqual({ ok: false, diskConflict: 'changed' })
    expect(callsTo('files.writeTerminalArtifact')).toHaveLength(0)
  })

  it('reports a file deleted on its host as missing', async () => {
    runtimeEnvironmentCall.mockImplementation(async () =>
      refused("ENOENT: no such file or directory, open '/private/tmp/handoff.md'")
    )

    await expect(save('# new', '# old')).resolves.toEqual({ ok: false, diskConflict: 'missing' })
    expect(callsTo('files.writeTerminalArtifact')).toHaveLength(0)
  })

  // Why: a same-id re-pair mid-save must not let a renewed grant write the replacement host's file.
  it('pins every step of a save to the pairing it started on', async () => {
    replaceRuntimeEnvironmentRevisions([{ id: 'env-1', createdAt: 1, pairingRevision: 7 }])
    runtimeEnvironmentCall.mockImplementation(async ({ method, params }) => {
      if (method === 'files.resolveTerminalPath') {
        return granted('g-2')
      }
      if (grantIdOf(params) === 'g-1') {
        replaceRuntimeEnvironmentRevisions([{ id: 'env-1', createdAt: 2, pairingRevision: 8 }])
        return refused('terminal_file_grant_expired')
      }
      return method === 'files.readTerminalArtifact' ? read('# old') : ok({ ok: true })
    })

    await save('# new', '# old').catch(() => undefined)

    const revisions = runtimeEnvironmentCall.mock.calls
      .map(([call]) => call)
      .filter((call) => call.method !== 'status.get')
      .map((call) => call.expectedEnvironmentPairingRevision)
    expect(new Set(revisions)).toEqual(new Set([7]))
  })

  // Why: a quoted path can spell "not found"; only the error itself proves absence.
  it('surfaces a permission failure on a path that mentions not found', async () => {
    runtimeEnvironmentCall.mockImplementation(async () =>
      refused("EACCES: permission denied, open '/tmp/not found.md'")
    )

    await expect(save('# new', '# old')).rejects.toThrow('EACCES')
    expect(callsTo('files.writeTerminalArtifact')).toHaveLength(0)
  })

  it('explains that a file deleted on its host cannot be recreated through its grant', async () => {
    runtimeEnvironmentCall.mockImplementation(async () =>
      refused("ENOENT: no such file or directory, open '/private/tmp/handoff.md'")
    )

    await expect(
      writeRuntimeTerminalArtifactFile({
        target: { kind: 'environment', environmentId: 'env-1' },
        worktreeId: 'wt-1',
        absolutePath: PATH,
        grantId: 'g-1',
        content: '# new',
        precondition: { expectedSignature: getDiskBaselineSignature('# old'), allowMissing: true }
      })
    ).rejects.toThrow("can't recreate it")
    expect(callsTo('files.writeTerminalArtifact')).toHaveLength(0)
  })

  // Why: a committed write whose reply was lost must still settle the save, or the next one conflicts.
  it('treats a lost reply as saved when the host already holds the new text', async () => {
    let written = false
    runtimeEnvironmentCall.mockImplementation(async ({ method }) => {
      if (method === 'files.writeTerminalArtifact') {
        written = true
        throw new Error('Request timed out')
      }
      return read(written ? '# new' : '# old')
    })

    await expect(save('# new', '# old')).resolves.toEqual({ ok: true })
  })

  it('reads back through a fresh grant when the dropped reply also revoked the old one', async () => {
    let written = false
    runtimeEnvironmentCall.mockImplementation(async ({ method, params }) => {
      if (method === 'files.resolveTerminalPath') {
        return granted('g-2')
      }
      if (method === 'files.writeTerminalArtifact') {
        written = true
        throw new Error('Request timed out')
      }
      if (written && grantIdOf(params) === 'g-1') {
        return refused('terminal_file_grant_expired')
      }
      return read(written ? '# new' : '# old')
    })

    await expect(save('# new', '# old')).resolves.toEqual({ ok: true })
  })

  it('keeps a host refusal of the write even when the text on disk already matches', async () => {
    let attempted = false
    runtimeEnvironmentCall.mockImplementation(async ({ method }) => {
      if (method === 'files.writeTerminalArtifact') {
        attempted = true
        return refused('EACCES: permission denied')
      }
      return read(attempted ? '# new' : '# old')
    })

    await expect(save('# new', '# old')).rejects.toThrow('EACCES')
  })

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

  it('never reports a discarded save as written, even when the host text matches', async () => {
    runtimeEnvironmentCall.mockImplementation(async () => read('# new'))

    await expect(
      writeRuntimeTerminalArtifactFile({
        target: { kind: 'environment', environmentId: 'env-1' },
        worktreeId: 'wt-1',
        absolutePath: PATH,
        grantId: 'g-1',
        content: '# new',
        beforeSend: () => {
          throw new Error('discarded')
        }
      })
    ).rejects.toThrow('discarded')
  })
})
