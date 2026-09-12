import { describe, expect, it } from 'vitest'
import { writeRuntimeFile } from './runtime-file-mutation-client'
import {
  installRuntimeFileClientEnvironment,
  runtimeEnvironmentCall
} from './runtime-file-client-test-harness'

installRuntimeFileClientEnvironment()

/** Context whose file operations are owned by a remote runtime environment. */
const remoteRuntimeContext = {
  settings: { activeRuntimeEnvironmentId: 'env-1' },
  worktreeId: 'wt-1',
  worktreePath: '/repo'
}

function stubRuntimeOk(): void {
  runtimeEnvironmentCall.mockResolvedValue({
    id: 'write',
    ok: true,
    result: { ok: true },
    _meta: { runtimeId: 'remote-runtime' }
  })
}

describe('writeRuntimeFile on a remote runtime environment', () => {
  it('dispatches base64 payloads through files.writeBase64', async () => {
    stubRuntimeOk()

    await writeRuntimeFile(remoteRuntimeContext as never, '/repo/book.xlsx', 'QkFTRTY0', 'base64')

    const base64Call = runtimeEnvironmentCall.mock.calls.find(
      (call) => call[0].method === 'files.writeBase64'
    )
    expect(base64Call).toBeTruthy()
    expect(base64Call![0].params).toMatchObject({
      relativePath: 'book.xlsx',
      contentBase64: 'QkFTRTY0'
    })
    // The text-only method must not be used for a binary workbook.
    expect(runtimeEnvironmentCall.mock.calls.some((call) => call[0].method === 'files.write')).toBe(
      false
    )
  })

  it('still sends text through files.write', async () => {
    stubRuntimeOk()

    await writeRuntimeFile(remoteRuntimeContext as never, '/repo/note.txt', 'hello')

    const textCall = runtimeEnvironmentCall.mock.calls.find(
      (call) => call[0].method === 'files.write'
    )
    expect(textCall).toBeTruthy()
    expect(textCall![0].params).toMatchObject({ relativePath: 'note.txt', content: 'hello' })
    expect(
      runtimeEnvironmentCall.mock.calls.some((call) => call[0].method === 'files.writeBase64')
    ).toBe(false)
  })
})
