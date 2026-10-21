// Why: Monaco's TypeScript worker names each file by its model URI, so the owner part of that
// URI decides whether imports between open tabs resolve and whether `.tsx` parses as TSX.
import { describe, expect, it } from 'vitest'
import { URI } from 'monaco-editor/esm/vs/base/common/uri.js'
import { TypeScriptWorker } from 'monaco-editor/esm/vs/language/typescript/tsWorker.js'
import { ScriptKind } from 'monaco-editor/esm/vs/language/typescript/lib/typescriptServices.js'
import { toEditorModelUri } from './editor-model-uri'

function workerWith(files: Record<string, string>) {
  const mirrors = Object.entries(files).map(([uri, text]) => ({
    uri: URI.parse(uri),
    version: 1,
    getValue: () => text
  }))
  return new TypeScriptWorker(
    { getMirrorModels: () => mirrors },
    {
      // Monaco's defaults plus the JSX setting Orca applies in monaco-setup.
      compilerOptions: { allowNonTsExtensions: true, target: 99, jsx: 1 },
      extraLibs: {},
      inlayHintsOptions: {}
    }
  )
}

describe('editor model URIs in the TypeScript language service', () => {
  const hostA = '["hub-a","ssh:target"]'
  const viewText = "import { value } from './value'\nexport const view = <div>{value}</div>\n"

  it.each([
    ['a local file', ''],
    ['a remote file', hostA]
  ])('reads %s named .tsx as TSX', (_label, owner) => {
    const view = toEditorModelUri('/repo/src/view.tsx', owner)
    expect(workerWith({ [view]: viewText }).getScriptKind(view)).toBe(ScriptKind.TSX)
  })

  it("resolves an import to the open file on the same host, not another host's", async () => {
    const view = toEditorModelUri('/repo/src/view.tsx', hostA)
    const value = toEditorModelUri('/repo/src/value.ts', hostA)
    const otherHostValue = toEditorModelUri('/repo/src/value.ts', '["hub-b","ssh:target"]')
    const worker = workerWith({
      [view]: viewText,
      [value]: 'export const value = 1\n',
      [otherHostValue]: 'export const value = 2\n'
    })

    const definitions = await worker.getDefinitionAtPosition(view, viewText.indexOf('value'))

    expect(definitions?.map((definition) => definition.fileName)).toEqual([value])
  })

  it('serves hover and definitions for a remote UNC file, apart from the same POSIX path', async () => {
    const text = "import { value } from './value'\nvalue\n"
    const view = toEditorModelUri('//server/share/src/view.ts', hostA)
    const value = toEditorModelUri('//server/share/src/value.ts', hostA)
    const worker = workerWith({
      [view]: text,
      [value]: 'export const value = 1\n',
      [toEditorModelUri('/server/share/src/value.ts', hostA)]: 'export const value = 2\n'
    })
    const position = text.lastIndexOf('value')

    const definitions = await worker.getDefinitionAtPosition(view, position)
    const hover = await worker.getQuickInfoAtPosition(view, position)

    expect(definitions?.map((definition) => definition.fileName)).toEqual([value])
    expect(hover?.displayParts?.map((part) => part.text).join('')).toContain('value: 1')
  })

  it.each([
    ['../value', '/repo/value.ts'],
    ['../../../../../repo/src/value', '/repo/src/value.ts'],
    ['../../../../../../value', '/value.ts']
  ])("keeps %s inside the owner's tree", async (specifier, sameHostPath) => {
    const text = `import { value } from '${specifier}'\nvalue\n`
    const view = toEditorModelUri('/repo/src/view.ts', hostA)
    const sameHost = toEditorModelUri(sameHostPath, hostA)
    const worker = workerWith({
      [view]: text,
      [sameHost]: 'export const value = 1\n',
      // Local files and another host's files at every path the import could climb to.
      ...Object.fromEntries(
        ['/repo/value.ts', '/repo/src/value.ts', '/value.ts'].flatMap((path) => [
          [toEditorModelUri(path), 'export const value = 2\n'],
          [toEditorModelUri(path, '["hub-b","ssh:target"]'), 'export const value = 3\n']
        ])
      )
    })

    const definitions = await worker.getDefinitionAtPosition(view, text.lastIndexOf('value'))

    expect(definitions?.map((definition) => definition.fileName)).toEqual([sameHost])
  })
})
