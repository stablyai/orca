import { describe, expect, it, vi } from 'vitest'
import type { DebugSnapshot } from '../../../../preload/api/debug-api'
import type { DebugClient } from './debug-client'
import type { DebugEditorBinding, DebugMonaco } from './connect-debug-editor'
import { createDebugSessionStore } from './use-debug-session'
import {
  ensureDebugHoverProvider,
  hoverExpressionAt,
  provideDebugHover,
  registerDebugHoverModel
} from './debug-hover'

function snapshot(worktreePath: string, stopped: boolean, hovers = true): DebugSnapshot {
  return {
    seq: 1,
    worktreePath,
    status: stopped ? 'stopped' : 'running',
    configName: 'Run',
    adapterId: 'debugpy',
    capabilities: { supportsEvaluateForHovers: hovers },
    stopped: stopped ? { reason: 'step', threadId: 1, allThreadsStopped: true } : null,
    threads: [{ id: 1, name: 'main' }],
    breakpoints: [],
    exceptionFilters: { available: [], enabled: [] },
    lastError: null
  }
}

const binding = (root: string): DebugEditorBinding => ({
  target: { repoId: 'r1', worktreePath: root },
  filePath: `${root}/app.py`,
  getCoreRoot: () => root,
  isThisFile: () => true,
  toEditorPath: (path) => path
})

let uriCounter = 0
function setup(lines: string[], stopped = snapshot('/a', true)) {
  const evaluate = vi.fn(async () => ({
    ok: true as const,
    value: { result: '42', variablesReference: 0 }
  }))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the store and hover call only these members.
  const client = {
    evaluate,
    stackTrace: vi.fn(),
    onState: () => () => {},
    onOutput: () => () => {}
  } as unknown as DebugClient
  const sessionStore = createDebugSessionStore(client)
  sessionStore.ingestSnapshot(stopped)
  sessionStore.setFrames('/a', 1, [{ id: 0, name: 'main', line: 1, column: 1 }])
  const uri = `file:///a/app-${++uriCounter}.py`
  const registration = registerDebugHoverModel(uri, binding('/a'))
  const model = { uri: { toString: () => uri }, getLineContent: (n: number) => lines[n - 1] }
  const hover = (column: number, line = 1) =>
    provideDebugHover(model, { lineNumber: line, column }, sessionStore, client)
  return { evaluate, sessionStore, hover, registration, model, client }
}

describe('hoverExpressionAt', () => {
  it('takes the member chain up to the hovered identifier', () => {
    expect(hoverExpressionAt('x = user.profile.name', 10)?.expression).toBe('user.profile')
    expect(hoverExpressionAt('x = user.profile.name', 5)?.expression).toBe('user')
    expect(hoverExpressionAt('total = items[0].price', 18)?.expression).toBe('items[0].price')
    expect(hoverExpressionAt('a[i]', 3)?.expression).toBe('i')
    expect(hoverExpressionAt('print(value)', 8)).toMatchObject({
      expression: 'value',
      startColumn: 7,
      endColumn: 12
    })
  })

  it('never returns a call', () => {
    expect(hoverExpressionAt('run(x).y', 8)).toBeNull()
    expect(hoverExpressionAt('a[f(1)].b', 9)?.expression ?? '').not.toContain('(')
    expect(hoverExpressionAt('x = 1 + 2', 5)).toBeNull()
  })
})

describe('debug hover', () => {
  it('evaluates in the selected frame with context hover, including frame 0', async () => {
    const { hover, evaluate } = setup(['result = user.name'])
    const answer = await hover(16)
    expect(evaluate).toHaveBeenCalledWith({
      repoId: 'r1',
      worktreePath: '/a',
      expression: 'user.name',
      frameId: 0,
      context: 'hover'
    })
    expect(answer?.contents[0].value).toContain('42')
    expect(answer?.range).toMatchObject({ startColumn: 10, endColumn: 19 })
  })

  it('fences the value one backtick longer than any run inside it, untrusted', async () => {
    const { hover, evaluate } = setup(['result = user.name'])
    const value = 'a ```` b\n~~~~\n[x](https://x.example) ``'
    evaluate.mockResolvedValueOnce({ ok: true, value: { result: value, variablesReference: 0 } })
    const answer = await hover(16)
    expect(answer?.contents[0]).toEqual({
      value: `\`\`\`\`\`text\n${value}\n\`\`\`\`\``,
      isTrusted: false
    })
  })

  it('returns null when not stopped', async () => {
    const { hover, evaluate } = setup(['user'], snapshot('/a', false))
    expect(await hover(2)).toBeNull()
    expect(evaluate).not.toHaveBeenCalled()
  })

  it('returns null when the adapter does not support hover evaluation', async () => {
    const { hover, evaluate } = setup(['user'], snapshot('/a', true, false))
    expect(await hover(2)).toBeNull()
    expect(evaluate).not.toHaveBeenCalled()
  })

  it('returns null for an expression with a call', async () => {
    const { hover, evaluate } = setup(['go().x'])
    expect(await hover(6)).toBeNull()
    expect(evaluate).not.toHaveBeenCalled()
  })

  it('returns null for a model registered by another worktree', async () => {
    const { sessionStore, client, evaluate } = setup(['user'])
    const uri = 'file:///b/app.py'
    registerDebugHoverModel(uri, binding('/b'))
    const model = { uri: { toString: () => uri }, getLineContent: () => 'user' }
    expect(
      await provideDebugHover(model, { lineNumber: 1, column: 2 }, sessionStore, client)
    ).toBeNull()
    expect(evaluate).not.toHaveBeenCalled()
  })

  it('returns null once the editor that registered the model is gone', async () => {
    const { hover, registration } = setup(['user'])
    registration.dispose()
    expect(await hover(2)).toBeNull()
  })

  it('registers the provider once per language', () => {
    const { sessionStore, client } = setup(['x'])
    const registerHoverProvider = vi.fn()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only languages.registerHoverProvider is read.
    const monaco = { languages: { registerHoverProvider } } as unknown as DebugMonaco
    ensureDebugHoverProvider(monaco, 'python', sessionStore, client)
    ensureDebugHoverProvider(monaco, 'python', sessionStore, client)
    ensureDebugHoverProvider(monaco, 'go', sessionStore, client)
    expect(registerHoverProvider.mock.calls.map(([language]) => language)).toEqual(['python', 'go'])
  })
})
