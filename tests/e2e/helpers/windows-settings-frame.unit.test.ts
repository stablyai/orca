import { describe, expect, it } from 'vitest'
import {
  buildCloseSettingsArgs,
  buildGetSettingsStateArgs,
  findSettingsSearchBoxCandidates,
  findSettingsSearchEchoLines,
  parseElementLineIndex,
  parseSettingsCloseOutput,
  parseSettingsLaunchOutput,
  requireUniqueSettingsSearchBoxIndex,
  selectSettingsSearchBoxLine
} from './windows-settings-frame'

describe('windows-settings-frame helpers', () => {
  describe('buildGetSettingsStateArgs', () => {
    it('targets the exact ApplicationFrameHost frame returned by the launcher', () => {
      const frame = { FramePid: 123, AppPid: 456, FrameHwnd: '0x1234' }

      expect(buildGetSettingsStateArgs(frame)).toEqual([
        'computer',
        'get-app-state',
        '--app',
        'pid:123',
        '--window-id',
        '4660',
        '--no-screenshot',
        '--json'
      ])
    })

    it('converts HWND above Number.MAX_SAFE_INTEGER without precision loss', () => {
      // Why: 0x20000000000001 = 9007199254740993 > 2^53. Using Number() would round to 9007199254740992.
      const frame = { FramePid: 1, AppPid: 2, FrameHwnd: '0x20000000000001' }
      const args = buildGetSettingsStateArgs(frame)
      const windowIdIndex = args.indexOf('--window-id')
      expect(args[windowIdIndex + 1]).toBe('9007199254740993')
    })
  })

  describe('buildCloseSettingsArgs', () => {
    it('passes FramePid and AppPid without mixing them up', () => {
      const frame = { FramePid: 123, AppPid: 456, FrameHwnd: '0x1234' }

      expect(buildCloseSettingsArgs(frame)).toEqual([
        '-Action',
        'Close',
        '-Hwnd',
        '0x1234',
        '-FramePid',
        '123',
        '-AppPid',
        '456',
        '-TimeoutMilliseconds',
        '5000'
      ])
    })
  })

  describe('parseSettingsLaunchOutput', () => {
    it('parses valid JSON with all required fields', () => {
      const stdout = '{"AppPid":456,"FramePid":123,"FrameHwnd":"0x1234"}'
      const result = parseSettingsLaunchOutput(stdout)

      expect(result).toEqual({ AppPid: 456, FramePid: 123, FrameHwnd: '0x1234' })
    })

    it('throws on malformed JSON with descriptive error', () => {
      expect(() => parseSettingsLaunchOutput('not json')).toThrow(
        /Failed to parse SettingsFrameLauncher output as JSON/
      )
    })

    it('throws on null JSON', () => {
      expect(() => parseSettingsLaunchOutput('null')).toThrow(
        /Invalid SettingsFrameLauncher payload shape/
      )
    })

    it('throws on valid JSON with invalid payload shape', () => {
      expect(() => parseSettingsLaunchOutput('{"foo":"bar"}')).toThrow(
        /Invalid SettingsFrameLauncher payload shape/
      )
    })

    it.each([
      ['AppPid', 0],
      ['AppPid', -1],
      ['AppPid', 1.5],
      ['FramePid', 0],
      ['FramePid', -1],
      ['FramePid', 1.5]
    ] as const)('rejects invalid %s=%s', (field, value) => {
      const payload = {
        AppPid: 1,
        FramePid: 2,
        FrameHwnd: '0x1',
        [field]: value
      }

      expect(() => parseSettingsLaunchOutput(JSON.stringify(payload))).toThrow(
        /Invalid SettingsFrameLauncher payload shape/
      )
    })

    it('throws on non-hex HWND', () => {
      expect(() =>
        parseSettingsLaunchOutput('{"AppPid":1,"FramePid":2,"FrameHwnd":"1234"}')
      ).toThrow(/Invalid SettingsFrameLauncher payload shape/)
    })

    it('throws on a zero HWND', () => {
      expect(() =>
        parseSettingsLaunchOutput('{"AppPid":1,"FramePid":2,"FrameHwnd":"0x0"}')
      ).toThrow(/Invalid SettingsFrameLauncher payload shape/)
      expect(() =>
        parseSettingsLaunchOutput('{"AppPid":1,"FramePid":2,"FrameHwnd":"0x0000"}')
      ).toThrow(/Invalid SettingsFrameLauncher payload shape/)
    })
  })

  describe('parseSettingsCloseOutput', () => {
    it('parses Closed status', () => {
      expect(parseSettingsCloseOutput('{"Status":"Closed"}')).toEqual({ Status: 'Closed' })
    })

    it('parses AlreadyGone status', () => {
      expect(parseSettingsCloseOutput('{"Status":"AlreadyGone"}')).toEqual({
        Status: 'AlreadyGone'
      })
    })

    it('parses IdentityMismatch status', () => {
      expect(parseSettingsCloseOutput('{"Status":"IdentityMismatch"}')).toEqual({
        Status: 'IdentityMismatch'
      })
    })

    it('throws on missing Status field', () => {
      expect(() => parseSettingsCloseOutput('{"foo":"bar"}')).toThrow(
        /Invalid SettingsFrameLauncher close payload/
      )
    })

    it('throws on unknown Status value', () => {
      expect(() => parseSettingsCloseOutput('{"Status":"Unknown"}')).toThrow(
        /Invalid SettingsFrameLauncher close payload/
      )
    })

    it('throws on null JSON', () => {
      expect(() => parseSettingsCloseOutput('null')).toThrow(
        /Invalid SettingsFrameLauncher close payload/
      )
    })

    it('throws on malformed JSON', () => {
      expect(() => parseSettingsCloseOutput('not json')).toThrow(
        /Failed to parse SettingsFrameLauncher close output as JSON/
      )
    })
  })
})

describe('findSettingsSearchBoxCandidates', () => {
  const enLine = '\t\t9 edit Find a setting, search settings, Secondary Actions: SetValue'
  const ruLine =
    '\t\t9 правка Поле поиска, поиск настроек, Value: zzqq7391, Secondary Actions: SetValue'

  it('finds the single search box by invariant metadata regardless of locale', () => {
    const tree = [
      'App=ApplicationFrameHost (pid 6300)',
      '\t1 ControlType.Window Параметры, Secondary Actions: SetValue',
      enLine,
      '\t\t\t78 кнопка Резервная копия, Secondary Actions: SetValue, Select',
      '\t\t\t88 переключатель Bluetooth, Secondary Actions: Toggle'
    ].join('\n')

    expect(findSettingsSearchBoxCandidates(tree)).toEqual([enLine])
  })

  it('keeps matching after typing when a localized role renders Value as a labeled segment', () => {
    expect(findSettingsSearchBoxCandidates(ruLine)).toEqual([ruLine])
  })

  it('keeps matching after typing when the English role renders the value bare', () => {
    const bare = '\t\t9 edit Find a setting zzqq7391, Secondary Actions: SetValue'
    expect(findSettingsSearchBoxCandidates(bare)).toEqual([bare])
  })

  it('returns every match so callers can fail loudly on ambiguity', () => {
    const tree = [enLine, ruLine.replace(/^\t\t9/, '\t\t10')].join('\n')
    expect(findSettingsSearchBoxCandidates(tree)).toHaveLength(2)
  })

  it('returns nothing when no element advertises SetValue as its only action', () => {
    expect(
      findSettingsSearchBoxCandidates('0 window Параметры\n\t1 текст Нет результатов')
    ).toEqual([])
  })
})

describe('parseElementLineIndex', () => {
  it('extracts the index from an indented localized element line', () => {
    expect(parseElementLineIndex('\t\t9 правка Поле поиска, поиск настроек')).toBe(9)
  })

  it('rejects non-element header lines', () => {
    expect(() => parseElementLineIndex('App=ApplicationFrameHost (pid 6300)')).toThrow(
      /Not an indexed element line/
    )
  })
})

describe('findSettingsSearchEchoLines', () => {
  it('returns only other indexed element lines containing the probe', () => {
    const tree = [
      '\t\t9 правка Поле поиска, поиск настроек, Value: zzqq7391, Secondary Actions: SetValue',
      '\t\t\t11 текст Нет результатов для zzqq7391'
    ].join('\n')

    expect(findSettingsSearchEchoLines(tree, 'zzqq7391', 9)).toEqual([
      '\t\t\t11 текст Нет результатов для zzqq7391'
    ])
  })

  it('ignores unindexed lines that contain the probe', () => {
    const tree = [
      'App=ApplicationFrameHost (pid 6300)',
      'Window: "zzqq7391", App: Параметры.',
      '\t\t9 правка Поле поиска, поиск настроек, Value: zzqq7391, Secondary Actions: SetValue'
    ].join('\n')

    expect(findSettingsSearchEchoLines(tree, 'zzqq7391', 9)).toEqual([])
  })

  it('excludes the field element even when its line text differs between snapshots', () => {
    const tree = '\t\t9 edit Find a setting zzqq7391, Secondary Actions: SetValue'

    expect(findSettingsSearchEchoLines(tree, 'zzqq7391', 9)).toEqual([])
  })
})

describe('selectSettingsSearchBoxLine', () => {
  const enLine = '\t\t9 edit Find a setting, search settings, Secondary Actions: SetValue'

  it('returns the line when exactly one candidate exists', () => {
    expect(selectSettingsSearchBoxLine(`0 window Settings\n${enLine}`)).toBe(enLine)
  })

  it('returns null when no candidate exists', () => {
    expect(selectSettingsSearchBoxLine('0 window Settings\n\t1 text Home')).toBeNull()
  })

  it('returns null when multiple candidates exist', () => {
    const tree = [enLine, '\t\t10 edit Other, Secondary Actions: SetValue'].join('\n')
    expect(selectSettingsSearchBoxLine(tree)).toBeNull()
  })
})

describe('requireUniqueSettingsSearchBoxIndex', () => {
  it('returns the element index for a single candidate', () => {
    expect(
      requireUniqueSettingsSearchBoxIndex('\t\t9 edit Find a setting, Secondary Actions: SetValue')
    ).toBe(9)
  })

  it('fails loudly listing candidates when none exist', () => {
    expect(() => requireUniqueSettingsSearchBoxIndex('0 window Settings')).toThrow(/got 0:/)
  })

  it('fails loudly listing candidates when several exist', () => {
    const tree = [
      '\t\t9 edit Find a setting, Secondary Actions: SetValue',
      '\t\t10 edit Other, Secondary Actions: SetValue'
    ].join('\n')
    expect(() => requireUniqueSettingsSearchBoxIndex(tree)).toThrow(/got 2:/)
    expect(() => requireUniqueSettingsSearchBoxIndex(tree)).toThrow(/Find a setting/)
  })
})
