import { describe, expect, it } from 'vitest'
import { filesystemPathToFileUri } from '../../file-links/file-uri-path'
import { classifyTerminalOscLinkTarget } from './terminal-osc-link-target'
import { detectTerminalFileUriLinks } from './terminal-file-uri-link'
import { resolveTerminalFileUrlTarget } from './terminal-file-url-target'

describe('resolveTerminalFileUrlTarget encoded colons', () => {
  it('preserves encoded colons in POSIX filenames produced by filesystemPathToFileUri', () => {
    const uri = filesystemPathToFileUri('/tmp/report:12')
    expect(uri).toBe('file:///tmp/report%3A12')

    expect(resolveTerminalFileUrlTarget(new URL(uri))).toEqual({
      filePath: '/tmp/report:12',
      line: null,
      column: null
    })

    expect(
      classifyTerminalOscLinkTarget(uri, { windowsPathsFirst: false, allowUncHost: false })
    ).toEqual({
      kind: 'file-url',
      target: { filePath: '/tmp/report:12', line: null, column: null }
    })

    expect(detectTerminalFileUriLinks(uri)).toMatchObject([
      { pathText: '/tmp/report:12', line: null, column: null }
    ])
  })

  it('parses an explicit literal :line:column suffix alongside an encoded colon in the name', () => {
    const uri = `${filesystemPathToFileUri('/tmp/report:12')}:8:3`
    expect(resolveTerminalFileUrlTarget(new URL(uri))).toEqual({
      filePath: '/tmp/report:12',
      line: 8,
      column: 3
    })
  })

  it('preserves encoded colons when a #L8 fragment specifies the line', () => {
    const uri = `${filesystemPathToFileUri('/tmp/report:12')}#L8`
    expect(resolveTerminalFileUrlTarget(new URL(uri))).toEqual({
      filePath: '/tmp/report:12',
      line: 8,
      column: null
    })
  })

  it('handles Windows drive paths with encoded colons and explicit line suffixes', () => {
    const encodedName = new URL(`${filesystemPathToFileUri('C:\\dir\\report:12')}`)
    expect(resolveTerminalFileUrlTarget(encodedName)).toEqual({
      filePath: 'C:/dir/report:12',
      line: null,
      column: null
    })

    const withLocation = new URL(`${filesystemPathToFileUri('C:\\dir\\report:12')}:8:3`)
    expect(resolveTerminalFileUrlTarget(withLocation)).toEqual({
      filePath: 'C:/dir/report:12',
      line: 8,
      column: 3
    })
  })

  it('keeps unencoded literal :line[:column] suffixes working on regular filenames', () => {
    expect(resolveTerminalFileUrlTarget(new URL('file:///tmp/report:12:4'))).toEqual({
      filePath: '/tmp/report',
      line: 12,
      column: 4
    })
  })

  it('does not treat :digits after a trailing separator as a line annotation', () => {
    expect(resolveTerminalFileUrlTarget(new URL('file:///tmp/dir/:10'))).toEqual({
      filePath: '/tmp/dir/:10',
      line: null,
      column: null
    })
    expect(resolveTerminalFileUrlTarget(new URL('file:///C:/dir/:10'))).toEqual({
      filePath: 'C:/dir/:10',
      line: null,
      column: null
    })
    expect(resolveTerminalFileUrlTarget(new URL('file:///tmp/dir%5C:10'))).toEqual({
      filePath: '/tmp/dir\\:10',
      line: null,
      column: null
    })
  })

  it('preserves UNC hostnames with allowUncHost when stripping :line:column', () => {
    expect(
      resolveTerminalFileUrlTarget(new URL('file://server/share/report%3A12:8:3'), {
        allowUncHost: true
      })
    ).toEqual({
      filePath: '//server/share/report:12',
      line: 8,
      column: 3
    })
  })
})
