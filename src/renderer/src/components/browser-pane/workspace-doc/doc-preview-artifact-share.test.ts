import { beforeEach, expect, it, vi } from 'vitest'
import type { DocPreviewGrantLocation } from '@/lib/doc-preview-grants'
import type { TerminalArtifactGrantTarget } from '@/runtime/runtime-terminal-artifact-grant'
import { readDocPreviewArtifactRequest } from './doc-preview-artifact-share'

const mocks = vi.hoisted(() => ({ acquire: vi.fn(), call: vi.fn() }))
vi.mock('@/runtime/runtime-terminal-artifact-grant', () => ({
  acquireTerminalArtifactGrant: mocks.acquire,
  pinTerminalArtifactGrantTarget: (target: TerminalArtifactGrantTarget) => ({
    ...target,
    expectedEnvironmentPairingRevision: 12
  })
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.call }))

beforeEach(() => {
  vi.resetAllMocks()
  mocks.call.mockResolvedValue({ content: '<h1>report</h1>', isBinary: false })
})

function location(): DocPreviewGrantLocation {
  return {
    owner: {
      kind: 'runtime',
      environmentId: 'vps',
      worktreeSelector: 'id:source',
      worktreeRoot: '/repo',
      fileAccess: 'terminal-artifact'
    },
    root: '/tmp/reports',
    requestBase: '/tmp/reports',
    entryRelativePath: 'report.html'
  }
}

it.each([
  ['/tmp/reports/report.html', '/tmp/reports/report.html'],
  ['C:/reports/report.html', 'C:\\Reports\\report.html']
])(
  'prepares %s from the canonical host grant and pins its pairing',
  async (requested, canonical) => {
    mocks.acquire.mockResolvedValue({
      grantId: 'host-grant',
      absolutePath: canonical,
      readOnly: false
    })
    await expect(
      readDocPreviewArtifactRequest(location(), requested, 'source-key')
    ).resolves.toMatchObject({
      content: '<h1>report</h1>',
      contentType: 'text/html',
      sourceKey: 'source-key'
    })
    expect(mocks.call).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'vps' },
      'files.readTerminalArtifactPreview',
      { worktree: 'id:source', grantId: 'host-grant', absolutePath: canonical },
      { timeoutMs: 15_000, expectedEnvironmentPairingRevision: 12 }
    )
  }
)

it('refuses a redirected source rather than sharing a different host file', async () => {
  mocks.acquire.mockResolvedValue({
    grantId: 'host-grant',
    absolutePath: '/private/secret.html',
    readOnly: false
  })
  await expect(
    readDocPreviewArtifactRequest(location(), '/tmp/reports/report.html', 'source-key')
  ).rejects.toThrow()
  expect(mocks.call).not.toHaveBeenCalled()
})
