import { describe, expect, it, vi } from 'vitest'
import { resolveOfficePreviewRouting } from './office-preview-plan'

vi.mock('@/lib/connection-owner-resolution', () => ({
  getConnectionIdForFileFromState: vi.fn()
}))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: vi.fn()
}))

describe('office preview routing', () => {
  it('renders the OOXML formats, including macro-enabled ones', () => {
    for (const path of ['/w/a.docx', '/w/a.xlsx', '/w/a.pptx', '/w/a.docm']) {
      expect(resolveOfficePreviewRouting(path).status).toBe('renderable')
    }
    expect(resolveOfficePreviewRouting('/w/deck.pptx')).toEqual({
      status: 'renderable',
      kind: 'ppt'
    })
  })

  it('reports a recognised-but-unrenderable format with its extension', () => {
    expect(resolveOfficePreviewRouting('/w/legacy.doc')).toEqual({
      status: 'unrenderable',
      extension: '.doc'
    })
    expect(resolveOfficePreviewRouting('/w/sheet.ODS')).toEqual({
      status: 'unrenderable',
      extension: '.ods'
    })
  })

  it('leaves everything else alone', () => {
    // CSV in particular: Orca's own viewer owns it and officecli rejects it outright.
    expect(resolveOfficePreviewRouting('/w/data.csv').status).toBe('not-office')
    expect(resolveOfficePreviewRouting('/w/index.html').status).toBe('not-office')
    expect(resolveOfficePreviewRouting('/w/README').status).toBe('not-office')
  })
})

describe('office host owner resolution', () => {
  it('never answers local for an unresolved owner', async () => {
    const { getConnectionIdForFileFromState } = await import('@/lib/connection-owner-resolution')
    const { resolveOfficeHostOwner } = await import('./office-preview-plan')
    vi.mocked(getConnectionIdForFileFromState).mockReturnValue(undefined)
    // Rendering here would hand a remote path to this machine's officecli and its fonts.
    // See docs/reference/ssh-execution-boundary.md.
    expect(resolveOfficeHostOwner({} as never, 'w1', '/w/a.docx')).toBeNull()
  })

  it('names the SSH target that owns the file', async () => {
    const { getConnectionIdForFileFromState } = await import('@/lib/connection-owner-resolution')
    const { resolveOfficeHostOwner } = await import('./office-preview-plan')
    vi.mocked(getConnectionIdForFileFromState).mockReturnValue('build-box-01')
    expect(resolveOfficeHostOwner({} as never, 'w1', '/w/a.docx')).toEqual({
      kind: 'ssh',
      connectionId: 'build-box-01'
    })
  })

  it('prefers a paired runtime over this machine', async () => {
    const { getConnectionIdForFileFromState } = await import('@/lib/connection-owner-resolution')
    const { getRuntimeEnvironmentIdForWorktree } = await import('@/lib/worktree-runtime-owner')
    const { resolveOfficeHostOwner } = await import('./office-preview-plan')
    vi.mocked(getConnectionIdForFileFromState).mockReturnValue(null)
    vi.mocked(getRuntimeEnvironmentIdForWorktree).mockReturnValue('env-7')
    expect(resolveOfficeHostOwner({} as never, 'w1', '/w/a.docx')).toEqual({
      kind: 'runtime',
      environmentId: 'env-7'
    })
    vi.mocked(getRuntimeEnvironmentIdForWorktree).mockReturnValue(null)
    expect(resolveOfficeHostOwner({} as never, 'w1', '/w/a.docx')).toEqual({ kind: 'local' })
  })
})
