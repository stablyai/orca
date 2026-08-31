import { describe, expect, it } from 'vitest'
import { buildDocPreviewDocumentIdentity } from './doc-preview-document-identity'

describe('buildDocPreviewDocumentIdentity', () => {
  it('splits a workspace-relative path into a dimmable directory and a filename', () => {
    expect(
      buildDocPreviewDocumentIdentity({
        filePath: '/repo/docs/reports/index.html',
        worktreeRoot: '/repo',
        hostLabel: 'Studio Mac mini'
      })
    ).toEqual({
      absolutePath: '/repo/docs/reports/index.html',
      directoryPrefix: 'docs/reports/',
      fileName: 'index.html',
      hostLabel: 'Studio Mac mini'
    })
  })

  it('leaves the directory empty for a document at the workspace root', () => {
    const identity = buildDocPreviewDocumentIdentity({
      filePath: '/repo/index.html',
      worktreeRoot: '/repo',
      hostLabel: null
    })

    expect(identity.directoryPrefix).toBe('')
    expect(identity.fileName).toBe('index.html')
  })

  // Why: an SSH preview of a file outside the workspace has no relative form, and a bare filename
  // would strip the only context the reader has for where it came from.
  it('falls back to the absolute path when the file sits outside the workspace', () => {
    const identity = buildDocPreviewDocumentIdentity({
      filePath: '/elsewhere/notes/report.html',
      worktreeRoot: '/repo',
      hostLabel: 'build-box'
    })

    expect(identity.directoryPrefix).toBe('/elsewhere/notes/')
    expect(identity.fileName).toBe('report.html')
  })

  // Why: the path is copied and read as the owning machine spells it, so a Windows host's
  // backslashes must survive rather than being normalised into a path that host would not accept.
  it('keeps the owning machine separator on Windows paths', () => {
    const identity = buildDocPreviewDocumentIdentity({
      filePath: 'C:\\repo\\docs\\index.html',
      worktreeRoot: 'C:\\repo',
      hostLabel: 'Windows box'
    })

    expect(identity.fileName).toBe('index.html')
    expect(identity.directoryPrefix.endsWith('/')).toBe(true)
    expect(identity.absolutePath).toBe('C:\\repo\\docs\\index.html')
  })

  it('carries an unknown owner through as null so the chip can drop the host pill', () => {
    expect(
      buildDocPreviewDocumentIdentity({
        filePath: '/repo/a.html',
        worktreeRoot: null,
        hostLabel: null
      }).hostLabel
    ).toBeNull()
  })
})
