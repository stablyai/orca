import type * as OnigurumaModule from 'vscode-oniguruma'
import onigurumaWasmUrl from 'vscode-oniguruma/release/onig.wasm?url'

export type Oniguruma = typeof OnigurumaModule

let onigurumaPromise: Promise<Oniguruma> | undefined

/** The renderer's one Oniguruma WASM instance, shared by every TextMate tokenizer. */
export function loadOniguruma(): Promise<Oniguruma> {
  onigurumaPromise ??= (async () => {
    const oniguruma = await import('vscode-oniguruma')
    const response = await fetch(onigurumaWasmUrl)
    if (!response.ok) {
      throw new Error(`Failed to load TextMate regex engine from ${onigurumaWasmUrl}`)
    }
    await oniguruma.loadWASM(response)
    return oniguruma
  })().catch((error: unknown) => {
    // Why: a failed fetch would otherwise leave every grammar plain until restart.
    onigurumaPromise = undefined
    throw error
  })
  return onigurumaPromise
}
