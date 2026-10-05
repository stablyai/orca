import { describe, expect, it, vi } from 'vitest'
import type * as Monaco from 'monaco-editor'
import type { LspDocumentSync, SyncModel } from './lsp-document-sync'
import { registerLspSemanticTokensProvider, remapSemanticTokens } from './lsp-semantic-tokens'

const canonical = {
  tokenTypes: ['namespace', 'variable', 'method'],
  tokenModifiers: ['declaration', 'readonly', 'static']
}

describe('remapSemanticTokens', () => {
  it('remaps type indices and modifier bits onto the canonical legend', () => {
    const server = { tokenTypes: ['method', 'variable'], tokenModifiers: ['static', 'declaration'] }
    const data = [0, 2, 3, 0, 0b01, 1, 4, 5, 1, 0b11]
    expect(Array.from(remapSemanticTokens(data, server, canonical))).toEqual([
      0, 2, 3, 2, 0b100, 1, 4, 5, 1, 0b101
    ])
  })

  it('drops tokens of unknown types and carries their deltas to the next token', () => {
    const server = { tokenTypes: ['variable', 'mystery'], tokenModifiers: ['unknownModifier'] }
    // Tokens: (0,2) variable, (0,6) mystery, (1,3) mystery, (1,8) variable with an unknown modifier.
    const data = [0, 2, 1, 0, 0, 0, 4, 1, 1, 0, 1, 3, 1, 1, 0, 0, 5, 1, 0, 1]
    expect(Array.from(remapSemanticTokens(data, server, canonical))).toEqual([
      0, 2, 1, 1, 0, 1, 8, 1, 1, 0
    ])
  })

  it('drops tokens whose type has no theme rule', () => {
    const server = { tokenTypes: ['macro', 'method'], tokenModifiers: [] }
    expect(Array.from(remapSemanticTokens([0, 1, 2, 0, 0, 0, 4, 3, 1, 0], server))).toEqual([
      0, 5, 3, 13, 0
    ])
  })

  it('ignores a trailing partial tuple', () => {
    const server = { tokenTypes: ['variable'], tokenModifiers: [] }
    expect(Array.from(remapSemanticTokens([0, 1, 2, 0, 0, 3], server, canonical))).toEqual([
      0, 1, 2, 1, 0
    ])
  })
})

type Provider = {
  onDidChange: (listener: () => void) => { dispose(): void }
  getLegend: () => unknown
  provideDocumentSemanticTokens: (model: unknown) => Promise<unknown>
}

function setup(client: { request: ReturnType<typeof vi.fn> } | null) {
  const registered: { provider?: Provider } = {}
  const register = vi.fn((_selector: unknown, provider: Provider) => {
    registered.provider = provider
    return { dispose: () => {} }
  })
  const openedListeners: ((model: SyncModel) => void)[] = []
  const sync = {
    clientFor: vi.fn().mockResolvedValue(client),
    onDocumentOpened: (listener: (model: SyncModel) => void) => {
      openedListeners.push(listener)
      return { dispose: () => {} }
    }
  }
  registerLspSemanticTokensProvider(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the provider only registers through this member.
    { languages: { registerDocumentSemanticTokensProvider: register } } as unknown as typeof Monaco,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the provider only calls clientFor and onDocumentOpened.
    sync as unknown as LspDocumentSync
  )
  const provider = registered.provider
  if (!provider) {
    throw new Error('provider not registered')
  }
  const model = { uri: { toString: () => 'file:///repo/a.rb' }, getLanguageId: () => 'ruby' }
  return { provider, register, model, openedListeners }
}

function rubyLspClient() {
  const request = vi.fn(async (method: string) =>
    method === 'orca/semanticTokensLegend'
      ? { tokenTypes: ['variable', 'method'], tokenModifiers: ['declaration'] }
      : { resultId: 'r1', data: [0, 0, 3, 1, 1] }
  )
  return { request }
}

describe('registerLspSemanticTokensProvider', () => {
  it('registers for ruby only with the canonical legend', () => {
    const { provider, register } = setup(null)
    expect(register).toHaveBeenCalledWith('ruby', expect.anything())
    expect(provider.getLegend()).toEqual(
      expect.objectContaining({
        tokenTypes: expect.arrayContaining(['variable', 'method', 'namespace']),
        tokenModifiers: expect.arrayContaining(['declaration', 'readonly'])
      })
    )
  })

  it('returns null without a session', async () => {
    const { provider, model } = setup(null)
    await expect(provider.provideDocumentSemanticTokens(model)).resolves.toBeNull()
  })

  it('fetches the legend once per client and returns remapped tokens', async () => {
    const client = rubyLspClient()
    const { provider, model } = setup(client)
    const first = await provider.provideDocumentSemanticTokens(model)
    await provider.provideDocumentSemanticTokens(model)
    // canonical 'method' is index 13, 'declaration' is bit 0.
    expect(first).toEqual({ resultId: 'r1', data: new Uint32Array([0, 0, 3, 13, 1]) })
    expect(client.request).toHaveBeenCalledWith('textDocument/semanticTokens/full', {
      textDocument: { uri: 'file:///repo/a.rb' }
    })
    const legendCalls = client.request.mock.calls.filter(
      ([method]) => method === 'orca/semanticTokensLegend'
    )
    expect(legendCalls).toHaveLength(1)
  })

  it('returns null when the server has no legend or a request fails', async () => {
    const noLegend = { request: vi.fn().mockResolvedValue(null) }
    const a = setup(noLegend)
    await expect(a.provider.provideDocumentSemanticTokens(a.model)).resolves.toBeNull()
    expect(noLegend.request).toHaveBeenCalledTimes(1)
    const failing = rubyLspClient()
    failing.request.mockImplementation(async (method: string) => {
      if (method === 'orca/semanticTokensLegend') {
        return { tokenTypes: ['variable'], tokenModifiers: [] }
      }
      throw new Error('LSP textDocument/semanticTokens/full timed out')
    })
    const b = setup(failing)
    await expect(b.provider.provideDocumentSemanticTokens(b.model)).resolves.toBeNull()
  })

  it('fires onDidChange when a ruby document is opened on a client', () => {
    const { provider, openedListeners } = setup(null)
    const listener = vi.fn()
    provider.onDidChange(listener)
    const ts = { getLanguageId: () => 'typescript' }
    const rb = { getLanguageId: () => 'ruby' }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: listeners only read the language id.
    openedListeners.forEach((fire) => fire(ts as unknown as SyncModel))
    expect(listener).not.toHaveBeenCalled()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: listeners only read the language id.
    openedListeners.forEach((fire) => fire(rb as unknown as SyncModel))
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
