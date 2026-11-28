import { describe, expect, it } from 'vitest'
import { URI } from 'monaco-editor/esm/vs/base/common/uri.js'
import { OrcaTypeScriptWorker } from './orca-typescript-worker'

const FILE_NAME = 'file:///repo/src/Card.tsx'
const SOURCE = `export function Card<T,>(items: T[]) {
  return <div className="card">{items.length < 2 ? <span>one</span> : null}</div>
}
`

function workerFor(source: string): OrcaTypeScriptWorker {
  const uri = URI.parse(FILE_NAME)
  return new OrcaTypeScriptWorker(
    { getMirrorModels: () => [{ uri, version: 1, getValue: () => source }] },
    // JsxEmit.Preserve, as the editor configures TSX.
    { compilerOptions: { jsx: 1 }, extraLibs: {}, inlayHintsOptions: {} }
  )
}

describe('OrcaTypeScriptWorker linked editing', () => {
  it('pairs the opening and closing tag names of a JSX element', async () => {
    const info = await workerFor(SOURCE).getLinkedEditingRangeAtPosition(
      FILE_NAME,
      SOURCE.indexOf('<div') + 2
    )
    expect(info?.ranges.map(({ start }) => start)).toEqual([
      SOURCE.indexOf('<div') + 1,
      SOURCE.indexOf('</div') + 2
    ])
    expect(info?.ranges.map(({ length }) => length)).toEqual([3, 3])
  })

  it('answers nothing for generics and comparisons', async () => {
    const worker = workerFor(SOURCE)
    expect(
      await worker.getLinkedEditingRangeAtPosition(FILE_NAME, SOURCE.indexOf('< 2') + 1)
    ).toBeNull()
    expect(
      await worker.getLinkedEditingRangeAtPosition(FILE_NAME, SOURCE.indexOf('<T') + 1)
    ).toBeNull()
  })
})
