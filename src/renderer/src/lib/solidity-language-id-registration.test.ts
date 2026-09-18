import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { detectLanguage } from './language-detect'

// Why: Monaco registers Solidity as id 'sol' with 'solidity' only an alias, and
// mapping an alias silently renders plaintext. Pin against the installed package
// so an upstream id change fails here instead of in the editor.
describe('solidity language id', () => {
  it('matches the id monaco-editor registers for .sol', () => {
    const require = createRequire(import.meta.url)
    const source = readFileSync(
      require.resolve('monaco-editor/esm/vs/basic-languages/solidity/solidity.contribution.js'),
      'utf8'
    )
    const registeredId = /id:\s*["']([^"']+)["']/.exec(source)?.[1]
    expect(registeredId).toBeDefined()
    expect(detectLanguage('contracts/Vault.sol')).toBe(registeredId)
  })
})
