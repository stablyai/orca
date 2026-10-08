// @vitest-environment happy-dom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { routeNativeChatHref } from '../../../../shared/native-chat-href-routing'
import CommentMarkdown from './CommentMarkdown'

afterEach(cleanup)

describe('CommentMarkdown host-confirmed file cases', () => {
  it.each([
    {
      name: 'slash commands, app routes and bare roots',
      content:
        'Type /orca-native-chat:orca-chat-visuals, run `/code-review`, strip `/api/v1`, use /clear and /compact, check /tmp, then open /tmp/report.html.',
      files: ['/tmp/report.html'],
      linked: ['/tmp/report.html']
    },
    {
      name: 'numeric versions and model names',
      content:
        'Try HTTP/1.1, 1.5/2.0 and z-ai/glm-5.3; open docs/archive.7z, man/ls.1 and lib/libfoo.so.1.',
      files: ['docs/archive.7z', 'man/ls.1', 'lib/libfoo.so.1'],
      linked: ['docs/archive.7z', 'man/ls.1', 'lib/libfoo.so.1']
    },
    {
      name: 'scheme-less hosts and dotted directories',
      content:
        'See example.com/docs/guide.html and 127.0.0.1/api/data.json, then open conf.d/nginx.conf and v1.2/notes.md.',
      files: ['conf.d/nginx.conf', 'v1.2/notes.md'],
      linked: ['conf.d/nginx.conf', 'v1.2/notes.md']
    },
    {
      name: 'commands in inline code and real spaced relative paths',
      content:
        'Run `git log origin/main..HEAD`; open `My Folder/notes.md` and "Brennan\'s Folder/notes.md".',
      files: ['My Folder/notes.md', "Brennan's Folder/notes.md"],
      linked: ['My Folder/notes.md', "Brennan's Folder/notes.md"]
    },
    {
      name: 'spaced paths anchored at a root',
      content:
        'Open `~/Library/Application Support/orca/log.json` and "C:\\My Folder\\notes.txt:12:3".',
      files: ['~/Library/Application Support/orca/log.json', String.raw`C:\My Folder\notes.txt`],
      linked: [
        '~/Library/Application Support/orca/log.json',
        String.raw`C:\My Folder\notes.txt:12:3`
      ]
    },
    {
      name: 'existing paths under known and unlisted roots',
      content:
        'Open /etc/hosts, /usr/local/bin, /data/out.json, /data/raw, /mnt/c/Users/me/notes.md and /Users/me/project/src/main.ts:12.',
      files: [
        '/etc/hosts',
        '/usr/local/bin',
        '/data/out.json',
        '/data/raw',
        '/mnt/c/Users/me/notes.md',
        '/Users/me/project/src/main.ts'
      ],
      linked: [
        '/etc/hosts',
        '/usr/local/bin',
        '/data/out.json',
        '/data/raw',
        '/mnt/c/Users/me/notes.md',
        '/Users/me/project/src/main.ts:12'
      ]
    },
    {
      name: 'plain file URIs with extensionless basenames',
      content: 'Open file:///tmp/Makefile and `file:///tmp/report%20notes.md#L4`.',
      files: ['/tmp/Makefile', '/tmp/report notes.md'],
      linked: ['file:///tmp/Makefile', 'file:///tmp/report%20notes.md#L4']
    },
    {
      name: 'command-shaped and host-shaped text that really names a path',
      content: 'Open /code-review, `/api/v1` and example.com/docs/guide.html.',
      files: ['/code-review', '/api/v1', 'example.com/docs/guide.html'],
      linked: ['/code-review', '/api/v1', 'example.com/docs/guide.html']
    },
    {
      name: 'missing file URIs',
      content: 'Open file:///tmp/missing and `file:///tmp/missing.ts`.',
      files: [],
      linked: []
    }
  ])('links only confirmed files for $name', ({ content, files, linked }) => {
    const { container } = render(
      <CommentMarkdown
        variant="document"
        content={content}
        onLinkClick={vi.fn()}
        fileLinkExists={(link) => files.includes(link.pathText)}
      />
    )

    const anchors = Array.from(container.querySelectorAll('a'))
    expect(anchors.map((anchor) => anchor.textContent)).toEqual(linked)
    for (const anchor of anchors) {
      expect(routeNativeChatHref(anchor.getAttribute('href')).kind).toBe('file')
    }
  })
})
