// @vitest-environment happy-dom
import { mkdtempSync, mkdirSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import CommentMarkdown from './CommentMarkdown'
import { resolveExplicitFileLinkTarget } from '../../../../shared/file-links/explicit-file-link-target'
import { routeNativeChatHref } from '../../../../shared/native-chat/native-chat-href-routing'

afterEach(cleanup)

it('retains bare-filename inference without attributing explicit links to it', () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-file-provenance-'))
  const workspace = join(root, 'workspace')
  const home = join(root, 'home')
  mkdirSync(workspace)
  mkdirSync(join(home, '.codex'), { recursive: true })
  writeFileSync(join(workspace, 'AGENTS.md'), 'Project instructions')
  writeFileSync(join(home, '.codex/AGENTS.md'), 'Global instructions')
  writeFileSync(join(workspace, 'report.html'), '<h1>Report</h1>')
  try {
    const { container } = render(
      <CommentMarkdown
        content={[
          'Updated the global configuration at `~/.codex/AGENTS.md`.',
          'The section added to `AGENTS.md` tells the agent how to search code.',
          '`./AGENTS.md` and [AGENTS.md](AGENTS.md) and [`AGENTS.md`](./AGENTS.md).',
          `\`${workspace}/AGENTS.md\``,
          '`AGENTS.md:12:4` and `report.html` and `missing.html`.'
        ].join('\n\n')}
        fileLinkExists={(link) => {
          const target = resolveExplicitFileLinkTarget(link, workspace, home)
          return target !== null && existsSync(target.absolutePath)
        }}
      />
    )
    const routes = Array.from(container.querySelectorAll('a'), (anchor) =>
      routeNativeChatHref(anchor.getAttribute('href'))
    )
    expect(routes).toEqual([
      { kind: 'file', pathText: '~/.codex/AGENTS.md', line: null },
      { kind: 'file', pathText: 'AGENTS.md', line: null, provenance: 'bare-filename' },
      { kind: 'file', pathText: './AGENTS.md', line: null },
      { kind: 'file', pathText: 'AGENTS.md', line: null },
      { kind: 'file', pathText: './AGENTS.md', line: null },
      { kind: 'file', pathText: `${workspace}/AGENTS.md`, line: null },
      { kind: 'file', pathText: 'AGENTS.md:12:4', line: null, provenance: 'bare-filename' },
      { kind: 'file', pathText: 'report.html', line: null, provenance: 'bare-filename' }
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
