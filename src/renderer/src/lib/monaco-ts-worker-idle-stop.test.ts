import { afterEach, describe, expect, it, vi } from 'vitest'
import { installMonacoTsWorkerIdleStop } from './monaco-ts-worker-idle-stop'

function createFakeMonaco(languages: string[]) {
  const listeners: (() => void)[] = []
  const defaults = () => ({
    getCompilerOptions: vi.fn(() => ({ jsx: 1 })),
    setCompilerOptions: vi.fn()
  })
  const typescriptDefaults = defaults()
  const javascriptDefaults = defaults()
  const subscribe = (listener: () => void) => {
    listeners.push(listener)
    return { dispose: vi.fn() }
  }
  const monaco = {
    editor: {
      getModels: () => languages.map((id) => ({ getLanguageId: () => id })),
      onWillDisposeModel: subscribe,
      onDidChangeModelLanguage: subscribe
    },
    typescript: { typescriptDefaults, javascriptDefaults }
  }
  return {
    monaco,
    languages,
    listeners,
    typescriptDefaults,
    javascriptDefaults
  }
}

afterEach(() => vi.useRealTimers())

describe('installMonacoTsWorkerIdleStop', () => {
  it('stops the TS/JS workers once no TS/JS model remains for the idle delay', () => {
    vi.useFakeTimers()
    const fake = createFakeMonaco(['typescript'])
    installMonacoTsWorkerIdleStop(fake.monaco, 1000)

    fake.languages.splice(0)
    fake.listeners[0]()
    vi.advanceTimersByTime(999)
    expect(fake.typescriptDefaults.setCompilerOptions).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(fake.typescriptDefaults.setCompilerOptions).toHaveBeenCalledWith({ jsx: 1 })
    expect(fake.javascriptDefaults.setCompilerOptions).toHaveBeenCalledWith({ jsx: 1 })
  })

  it('keeps the worker while a TS/JS model is still open', () => {
    vi.useFakeTimers()
    const fake = createFakeMonaco(['typescript', 'markdown'])
    installMonacoTsWorkerIdleStop(fake.monaco, 1000)

    fake.listeners[0]()
    vi.advanceTimersByTime(1000)
    expect(fake.typescriptDefaults.setCompilerOptions).not.toHaveBeenCalled()
  })
})
