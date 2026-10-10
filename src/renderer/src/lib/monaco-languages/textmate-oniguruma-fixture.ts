import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { createOnigScanner, createOnigString, loadWASM } from 'vscode-oniguruma'
import type { IOnigLib } from 'vscode-textmate'

const require = createRequire(import.meta.url)
let nodeOnigurumaPromise: Promise<IOnigLib> | undefined

export function loadNodeOniguruma(): Promise<IOnigLib> {
  nodeOnigurumaPromise ??= (async () => {
    const bytes = await readFile(require.resolve('vscode-oniguruma/release/onig.wasm'))
    await loadWASM(new Uint8Array(bytes))
    return { createOnigScanner, createOnigString }
  })()
  return nodeOnigurumaPromise
}
