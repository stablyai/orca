import { describe, expect, it } from 'vitest'
import {
  cursorProjectSlugFromTranscriptPath,
  cursorWorkspaceSlug,
  isCursorTranscriptInWorkspace
} from './cursor-workspace-slug'

describe('cursorWorkspaceSlug', () => {
  it('encodes POSIX paths the way Cursor names project buckets', () => {
    expect(cursorWorkspaceSlug('/Users/ada/code/orca')).toBe('Users-ada-code-orca')
  })

  it('encodes Windows drive paths, including the colon', () => {
    expect(cursorWorkspaceSlug('C:\\Dev\\simulations\\opc')).toBe('C-Dev-simulations-opc')
    expect(cursorWorkspaceSlug('C:/Users/alice/platform')).toBe('C-Users-alice-platform')
  })
})

describe('cursorProjectSlugFromTranscriptPath', () => {
  it('requires the .cursor/projects/<slug>/agent-transcripts layout', () => {
    expect(
      cursorProjectSlugFromTranscriptPath(
        '/home/u/.cursor/projects/Users-u-repo/agent-transcripts/sid/sid.jsonl'
      )
    ).toBe('Users-u-repo')
    expect(
      cursorProjectSlugFromTranscriptPath(
        'C:\\Users\\u\\.cursor\\projects\\c-Dev-simulations-opc\\agent-transcripts\\sid.jsonl'
      )
    ).toBe('c-Dev-simulations-opc')
    expect(
      cursorProjectSlugFromTranscriptPath('/home/u/.cursor/projects/slug/sid.jsonl')
    ).toBeNull()
    expect(
      cursorProjectSlugFromTranscriptPath('/tmp/unrelated/agent-transcripts/sid.jsonl')
    ).toBeNull()
    expect(
      cursorProjectSlugFromTranscriptPath(
        '/home/u/.cursor/projects/repo\\agent-transcripts/sid.jsonl'
      )
    ).toBeNull()
  })
})

describe('isCursorTranscriptInWorkspace', () => {
  it('matches a Windows folder workspace whose slug Cursor lowercased', () => {
    expect(
      isCursorTranscriptInWorkspace(
        'C:\\Users\\neil\\orca\\workspaces\\orca\\pr-13935-internal-review',
        'C:\\Users\\neil\\.cursor\\projects\\c-Users-neil-orca-workspaces-orca-pr-13935-internal-review\\agent-transcripts\\sid.jsonl'
      )
    ).toBe(true)
  })

  it('matches case and separator variants of the reported Windows workspace', () => {
    const transcript =
      'C:\\Users\\ada\\.cursor\\projects\\c-Dev-simulations-opc\\agent-transcripts\\sid.jsonl'
    expect(isCursorTranscriptInWorkspace('C:\\Dev\\simulations\\opc', transcript)).toBe(true)
    expect(isCursorTranscriptInWorkspace('c:/dev/simulations/opc', transcript)).toBe(true)
  })

  it('does not match a different Windows workspace', () => {
    expect(
      isCursorTranscriptInWorkspace(
        'C:\\Dev\\simulations\\opc',
        'C:\\Users\\u\\.cursor\\projects\\c-Dev-other\\agent-transcripts\\sid.jsonl'
      )
    ).toBe(false)
  })

  it('matches a WSL UNC workspace against a Linux Cursor project slug', () => {
    expect(
      isCursorTranscriptInWorkspace(
        '\\\\wsl.localhost\\Ubuntu\\home\\ada\\repo',
        '/home/ada/.cursor/projects/home-ada-repo/agent-transcripts/sid.jsonl'
      )
    ).toBe(true)
  })

  it.each(['/a/Repo', '/A/repo'])(
    'does not case-fold a one-letter POSIX workspace root: %s',
    (workspacePath) => {
      expect(
        isCursorTranscriptInWorkspace(
          workspacePath,
          '/home/ada/.cursor/projects/a-repo/agent-transcripts/sid.jsonl'
        )
      ).toBe(false)
    }
  )
})
