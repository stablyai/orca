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

  // Keep the absolute path for external SSH files; a filename alone loses their location.
  it('falls back to the absolute path when the file sits outside the workspace', () => {
    const identity = buildDocPreviewDocumentIdentity({
      filePath: '/elsewhere/notes/report.html',
      worktreeRoot: '/repo',
      hostLabel: 'build-box'
    })

    expect(identity.directoryPrefix).toBe('/elsewhere/notes/')
    expect(identity.fileName).toBe('report.html')
  })

  // Keep paths spelled for the owning Windows host, including its backslashes.
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
