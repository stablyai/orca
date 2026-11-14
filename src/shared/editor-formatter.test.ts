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
})
