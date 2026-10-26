import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createTerminalLinkTestDoubles } from './terminal-link-handlers-test-fixtures'
import { installTerminalLinkTestEnvironment } from './terminal-link-handlers-test-harness'
import { collectLinks } from './terminal-link-provider-buffer-fixtures'

const doubles = createTerminalLinkTestDoubles()
vi.mock('@/store', () => ({ useAppStore: { getState: () => doubles.storeState } }))
vi.mock('@/lib/connection-context', () => ({ getConnectionId: vi.fn(() => null) }))
installTerminalLinkTestEnvironment(doubles)

describe('terminal Markdown destination existence', () => {
  it('selects the decoded real file even when the literal-percent file also exists', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-markdown-link-'))
    try {
      const decoded = join(root, 'folder with spaces', 'report.pdf')
      const literal = join(root, 'folder%20with%20spaces', 'report.pdf')
      const unicode = join(root, 'Каталог', 'отчет.pdf')
      for (const file of [decoded, literal, unicode]) {
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, file)
      }
      vi.mocked(window.api.shell.pathExists).mockImplementation(async (path) => existsSync(path))
      const target = decoded.replaceAll(' ', '%20')
      const links = await collectLinks(`[${unicode}](${target})`)
      expect(links.map((link) => link.text)).toEqual([target])
      expect(window.api.shell.pathExists).toHaveBeenCalledWith(decoded.replaceAll('\\', '/'))
      expect(window.api.shell.pathExists).not.toHaveBeenCalledWith(literal.replaceAll('\\', '/'))
      expect((await collectLinks(`[${unicode}](${unicode})`)).map((link) => link.text)).toEqual([
        unicode
      ])
      expect((await collectLinks(literal)).map((link) => link.text)).toEqual([literal])
      expect(await collectLinks(`[${unicode}](${join(root, 'missing.pdf')})`)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
