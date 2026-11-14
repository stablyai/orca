import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { formatP4Spec, parseP4Spec } from './p4-spec'
import { parseRobocopySummary, robocopyArguments } from './workspace-copy-files'
import { createWorkspaceCopyHost, parseWindowsBuild } from './workspace-copy-host'
import { uniqueCopyName } from './workspace-copy-name-rules'
import { toCopyName } from './workspace-copy-names'
import { processesUnder, processLabel } from './workspace-copy-processes'
import { removeUnityWorkspaceEntry, setConfigClient, setIdeBindings } from './workspace-copy-rebind'

// Captured from robocopy on Windows 11 build 26200 with /NFL /NDL /NP /BYTES.
const ROBOCOPY_SUMMARY = `
------------------------------------------------------------------------------

               Total    Copied   Skipped  Mismatch    FAILED    Extras
    Dirs :         2         2         0         0         0         0
   Files :         2         2         0         0         0         0
   Bytes :        15        15         0         0         0         0
   Times :   0:00:00   0:00:00                       0:00:00   0:00:00


   Speed :              15,000 Bytes/sec.
`

describe('p4 spec forms', () => {
  it('round-trips multi-line and single-line fields, dropping comments', () => {
    const text =
      '# A Perforce Client Specification.\n\nClient:\tws\n\nRoot:\tD:\\ws\n\nView:\n\t//s/main/... //ws/...\n\t-//s/main/x/... //ws/x/...\n\nDescription:\n\tline one\n\tline two\n'
    const spec = parseP4Spec(text)
    expect(spec.get('Root')).toEqual(['D:\\ws'])
    expect(spec.get('View')).toHaveLength(2)
    expect(formatP4Spec(spec)).toBe(
      'Client:\tws\n\nRoot:\tD:\\ws\n\nView:\n\t//s/main/... //ws/...\n\t-//s/main/x/... //ws/x/...\n\nDescription:\n\tline one\n\tline two\n\n'
    )
  })
})

describe('copy names', () => {
  it('keeps valid names and hashes ones that had to change', () => {
    expect(toCopyName('fix-login')).toBe('fix-login')
    expect(toCopyName('Fix the login flow, please')).toMatch(/^Fix-the-login-f-[0-9a-f]{8}$/)
    expect(toCopyName('!!!')).toMatch(/^wt-[0-9a-f]{8}$/)
  })

  it('keeps a free name and numbers a taken one within 24 characters', () => {
    expect(uniqueCopyName('fix-login', ['other'])).toBe('fix-login')
    expect(uniqueCopyName('fix-login', ['FIX-LOGIN', 'fix-login-2'])).toBe('fix-login-3')
    expect(uniqueCopyName('a-very-long-copy-name-xx', ['a-very-long-copy-name-xx'])).toBe(
      'a-very-long-copy-name-2'
    )
  })
})

describe('robocopy', () => {
  it('reads copied files and bytes from the summary', () => {
    expect(parseRobocopySummary(ROBOCOPY_SUMMARY)).toEqual({
      files: 2,
      bytes: 15
    })
    expect(parseRobocopySummary('ERROR 5 (0x00000005) Access is denied.')).toBeNull()
  })

  it('passes exclusions as full paths and omits empty lists', () => {
    expect(robocopyArguments('D:\\ws', 'D:\\ws.wt\\a', [], [])).not.toContain('/XD')
    const args = robocopyArguments(
      'D:\\ws',
      'D:\\ws.wt\\a',
      ['D:\\ws\\Game\\Temp'],
      ['D:\\ws\\Game\\Library\\ilpp.pid']
    )
    expect(args.slice(args.indexOf('/XD'))).toEqual([
      '/XD',
      'D:\\ws\\Game\\Temp',
      '/XF',
      'D:\\ws\\Game\\Library\\ilpp.pid'
    ])
  })
})

describe('rebinding text', () => {
  it('rewrites only the P4CLIENT line naming the source client', () => {
    const text = 'P4PORT=srv:1666\r\nP4CLIENT=ws\r\n# P4CLIENT=other\r\n'
    expect(setConfigClient(text, 'WS', 'ws_wt_a')).toBe(
      'P4PORT=srv:1666\r\nP4CLIENT=ws_wt_a\r\n# P4CLIENT=other\r\n'
    )
  })

  it('rewrites whole client names and roots in Rider settings', () => {
    const text =
      '<a v="ws" /><b v="ws_other" /><c v="D:\\ws\\Game" /><d v="D:/ws/Game" /><e v="D:\\wsx" />'
    expect(
      setIdeBindings(
        text,
        { client: 'ws', root: 'D:\\ws' },
        { client: 'ws_wt_a', root: 'D:\\ws.wt\\a' }
      )
    ).toBe(
      '<a v="ws_wt_a" /><b v="ws_other" /><c v="D:\\ws.wt\\a\\Game" /><d v="D:/ws.wt/a/Game" /><e v="D:\\wsx" />'
    )
  })

  it("drops Unity's workspace entry and nothing else", () => {
    const text =
      'EditorUserSettings:\n  m_ConfigSettings:\n    vcPerforceWorkspace:\n      value: 1a\n      flags: 0\n    vcPerforceServer:\n      value: 2b\n'
    expect(removeUnityWorkspaceEntry(text)).toBe(
      'EditorUserSettings:\n  m_ConfigSettings:\n    vcPerforceServer:\n      value: 2b\n'
    )
  })
})

describe('host details', () => {
  it('parses the Windows build from os.release()', () => {
    expect(parseWindowsBuild('10.0.26200')).toBe(26200)
    expect(parseWindowsBuild('6.8.0-45-generic')).toBeNull()
  })

  it('names processes inside a copy without matching a sibling with a longer name', async () => {
    const copy = join(tmpdir(), 'ws.wt', 'copy-1')
    const host = createWorkspaceCopyHost({
      listProcesses: async () => [
        {
          pid: 1,
          name: 'Unity.exe',
          commandLine: `Unity.exe -projectPath "${join(copy, 'Game')}"`
        },
        {
          pid: 2,
          name: 'Unity.exe',
          commandLine: `Unity.exe -projectPath ${copy}0`
        },
        { pid: 3, name: 'pwsh.exe', commandLine: `pwsh.exe -wd ${copy}` }
      ]
    })
    expect((await processesUnder(host, copy)).map(processLabel)).toEqual([
      'Unity.exe (pid 1)',
      'pwsh.exe (pid 3)'
    ])
  })
})
