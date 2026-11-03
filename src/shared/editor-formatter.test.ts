import { describe, expect, it } from 'vitest'
import { editorFormatterArgv } from './editor-formatter'

describe('formatter command arguments', () => {
  it('substitutes quoted paths once without interpreting shell syntax in filenames', () => {
    const file = "/repo/a ' $(touch nope) ${relativeFile}.ts"
    expect(
      editorFormatterArgv(
        'formatter --stdin-filepath "${file}" --relative=${relativeFile}',
        file,
        'src/${file}.ts',
        'darwin'
      )
    ).toEqual(['formatter', '--stdin-filepath', file, '--relative=src/${file}.ts'])
  })

  it('keeps native Windows paths and executable spaces intact', () => {
    expect(
      editorFormatterArgv(
        '"C:\\Program Files\\Formatter\\fmt.exe" --path "${file}"',
        'C:\\repo\\a b.ts',
        'a b.ts',
        'win32'
      )
    ).toEqual(['C:\\Program Files\\Formatter\\fmt.exe', '--path', 'C:\\repo\\a b.ts'])
  })

  it.each(['', 'formatter "unfinished', 'formatter --write ${file}', 'gofmt -w ${file}'])(
    'rejects invalid or file-writing command %s',
    (command) => {
      expect(() => editorFormatterArgv(command, '/repo/a.ts', 'a.ts', 'linux')).toThrow()
    }
  )
})
