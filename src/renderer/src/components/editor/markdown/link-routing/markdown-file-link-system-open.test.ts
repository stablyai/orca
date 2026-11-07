import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openMarkdownFileLinkWithSystemDefault } from './markdown-file-link-system-open'

const openFileUri = vi.fn()
const openInFileManager = vi.fn()
const uri = process.platform === 'win32' ? 'file:///C:/repo/run.sh' : 'file:///repo/run.sh'

describe('openMarkdownFileLinkWithSystemDefault', () => {
  beforeEach(() => {
    openFileUri.mockReset()
    openInFileManager.mockReset()
    vi.stubGlobal('window', {
      api: { shell: { openFileUri, openInFileManager } }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.each(['opened', 'revealed', 'failed', undefined])('does nothing more after %s', async (r) => {
    const openInEditor = vi.fn()
    openFileUri.mockResolvedValue(r)

    await openMarkdownFileLinkWithSystemDefault(uri, openInEditor)

    expect(openFileUri).toHaveBeenCalledWith(uri, 'local')
    expect(openInEditor).not.toHaveBeenCalled()
    expect(openInFileManager).not.toHaveBeenCalled()
  })

  it('opens scripts main declined to launch in an editor tab', async () => {
    const openInEditor = vi.fn()
    openFileUri.mockResolvedValue('open-in-editor')

    await openMarkdownFileLinkWithSystemDefault(uri, openInEditor)

    expect(openInEditor).toHaveBeenCalledTimes(1)
    expect(openInFileManager).not.toHaveBeenCalled()
  })

  it('reveals scripts when the link has no workspace for a tab', async () => {
    openFileUri.mockResolvedValue('open-in-editor')

    await openMarkdownFileLinkWithSystemDefault(uri, null)

    expect(openInFileManager).toHaveBeenCalledWith(
      process.platform === 'win32' ? 'C:\\repo\\run.sh' : '/repo/run.sh',
      'local'
    )
  })
})
