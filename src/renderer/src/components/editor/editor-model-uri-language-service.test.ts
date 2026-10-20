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
})
