import { describe, expect, it, vi } from 'vitest'
import { createTerminalLinkTestDoubles } from './terminal-link-handlers-test-fixtures'
import { installTerminalLinkTestEnvironment } from './terminal-link-handlers-test-harness'
import { collectLinks } from './terminal-link-provider-buffer-fixtures'

const doubles = createTerminalLinkTestDoubles()

vi.mock('@/store', () => ({
  useAppStore: { getState: () => doubles.storeState }
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionId: vi.fn(() => null)
}))

installTerminalLinkTestEnvironment(doubles)

describe('terminal host-confirmed chat regression cases', () => {
  it.each([
    {
      text: 'Type /orca-native-chat:orca-chat-visuals, run /code-review, strip /api/v1, use /clear and /compact, then open /tmp/report.html.',
      files: ['/tmp/report.html'],
      linked: ['/tmp/report.html']
    },
    {
      text: 'HTTP/1.1, 1.5/2.0, z-ai/glm-5.3; docs/archive.7z, man/ls.1, lib/libfoo.so.1.',
      files: ['/repo/docs/archive.7z', '/repo/man/ls.1', '/repo/lib/libfoo.so.1'],
      linked: ['docs/archive.7z', 'man/ls.1', 'lib/libfoo.so.1']
    },
    {
      text: 'See example.com/docs/guide.html and 127.0.0.1/api/data.json, then open conf.d/nginx.conf.',
      files: ['/repo/conf.d/nginx.conf'],
      linked: ['conf.d/nginx.conf']
    },
    {
      text: 'docs/Makefile, .github/CODEOWNERS; BUILD SUCCESSFUL',
      files: ['/repo/docs/Makefile', '/repo/.github/CODEOWNERS'],
      linked: ['docs/Makefile', '.github/CODEOWNERS']
    },
    {
      text: 'Open file:///tmp/Makefile and file:///tmp/report%20notes.md#L4.',
      files: ['/tmp/Makefile', '/tmp/report notes.md'],
      linked: ['file:///tmp/Makefile', 'file:///tmp/report%20notes.md#L4']
    }
  ])('keeps only existing paths in $text', async ({ text, files, linked }) => {
    vi.mocked(window.api.shell.pathExists).mockImplementation(async (path) => files.includes(path))

    const links = await collectLinks(text)

    expect(links.map((link) => link.text)).toEqual(linked)
  })

  it('allows command-shaped and host-shaped text when it really names a path', async () => {
    const paths = ['/code-review', '/api/v1', '/repo/example.com/docs/guide.html']
    vi.mocked(window.api.shell.pathExists).mockImplementation(async (path) => paths.includes(path))

    const links = await collectLinks('/code-review, /api/v1, example.com/docs/guide.html')

    expect(links.map((link) => link.text)).toEqual([
      '/code-review',
      '/api/v1',
      'example.com/docs/guide.html'
    ])
  })
})
