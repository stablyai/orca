import { describe, expect, it, vi } from 'vitest'

const { renewTerminalArtifactGrant, hostSavesGrantedFiles } = vi.hoisted(() => ({
  renewTerminalArtifactGrant: vi.fn(),
  hostSavesGrantedFiles: vi.fn(async () => true)
}))
vi.mock('@/runtime/runtime-terminal-artifact-grant', () => ({
  renewTerminalArtifactGrant,
  hostSavesGrantedFiles
}))

import {
  grantRestoredHostFile,
  REMOTE_EXTERNAL_FILE_UNAVAILABLE_MESSAGE
} from './restored-host-file-grant'

const target = { kind: 'environment' as const, environmentId: 'runtime-1' }
const PATH = '/work/reports/audit.md'

describe('a restored tab for a host file outside every workspace', () => {
  it('asks its host for a fresh grant, since grants are never persisted', async () => {
    renewTerminalArtifactGrant.mockResolvedValue({ grantId: 'g-2', readOnly: false })

    await expect(grantRestoredHostFile(target, 'wt-1', PATH)).resolves.toEqual({
      grantId: 'g-2',
      readOnly: false
    })
    expect(renewTerminalArtifactGrant).toHaveBeenCalledWith({
      target,
      worktreeId: 'wt-1',
      absolutePath: PATH
    })
  })

  it('stays unavailable when the host has no such file', async () => {
    renewTerminalArtifactGrant.mockResolvedValue(null)

    await expect(grantRestoredHostFile(target, 'wt-1', PATH)).rejects.toThrow(
      REMOTE_EXTERNAL_FILE_UNAVAILABLE_MESSAGE
    )
  })

  it('never asks a host for a tab whose owner is this computer', async () => {
    renewTerminalArtifactGrant.mockClear()

    await expect(grantRestoredHostFile({ kind: 'local' }, 'wt-1', PATH)).rejects.toThrow(
      REMOTE_EXTERNAL_FILE_UNAVAILABLE_MESSAGE
    )
    expect(renewTerminalArtifactGrant).not.toHaveBeenCalled()
  })

  it('restores read-only where a fresh open would be read-only', async () => {
    renewTerminalArtifactGrant.mockResolvedValue({ grantId: 'g-3', readOnly: false })
    hostSavesGrantedFiles.mockResolvedValueOnce(false)

    await expect(grantRestoredHostFile(target, 'wt-1', PATH)).resolves.toEqual({
      grantId: 'g-3',
      readOnly: true
    })
  })
})
