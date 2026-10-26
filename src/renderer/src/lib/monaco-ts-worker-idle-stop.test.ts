import { afterEach, describe, expect, it, vi } from 'vitest'
import { installMonacoTsWorkerIdleStop } from './monaco-ts-worker-idle-stop'

function createModel(languageId: string) {
  return { getLanguageId: () => languageId }
}

function createFakeMonaco(languages: string[]) {
  const models = languages.map(createModel)
  const defaults = () => ({
    getCompilerOptions: vi.fn(() => ({ jsx: 1 })),
    setCompilerOptions: vi.fn()
  })
  const typescriptDefaults = defaults()
  const javascriptDefaults = defaults()
  const onWillDisposeModel = vi.fn<
    (listener: (model: ReturnType<typeof createModel>) => void) => { dispose(): void }
  >(() => ({ dispose: vi.fn() }))
  const onDidChangeModelLanguage = vi.fn<
    (listener: (event: { model: ReturnType<typeof createModel>; oldLanguage: string }) => void) => {
      dispose(): void
    }
  >(() => ({ dispose: vi.fn() }))
  const monaco = {
    editor: { getModels: () => models, onWillDisposeModel, onDidChangeModelLanguage },
    typescript: { typescriptDefaults, javascriptDefaults }
  }
  return {
    monaco,
    models,
    disposeModel(model: ReturnType<typeof createModel>) {
      onWillDisposeModel.mock.calls[0][0](model)
      models.splice(models.indexOf(model), 1)
    },
    changeLanguage(model: ReturnType<typeof createModel>, language: string) {
      const oldLanguage = model.getLanguageId()
      model.getLanguageId = () => language
      onDidChangeModelLanguage.mock.calls[0][0]({ model, oldLanguage })
    },
    typescriptDefaults,
    javascriptDefaults
  }
}

afterEach(() => vi.useRealTimers())

describe('installMonacoTsWorkerIdleStop', () => {
  it('stops on the original deadline despite unrelated model events', () => {
    vi.useFakeTimers()
    const fake = createFakeMonaco(['typescript', 'markdown', 'plaintext'])
    installMonacoTsWorkerIdleStop(fake.monaco, 1000)

    fake.disposeModel(fake.models[0])
    vi.advanceTimersByTime(500)
    fake.disposeModel(fake.models[0])
    fake.changeLanguage(fake.models[0], 'markdown')
    vi.advanceTimersByTime(499)
    expect(fake.typescriptDefaults.setCompilerOptions).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(fake.typescriptDefaults.setCompilerOptions).toHaveBeenCalledWith({ jsx: 1 })
    expect(fake.javascriptDefaults.setCompilerOptions).toHaveBeenCalledWith({ jsx: 1 })
  })

  it('rechecks reopened TS/JS models and waits for their departure', () => {
    vi.useFakeTimers()
    const fake = createFakeMonaco(['typescript'])
    installMonacoTsWorkerIdleStop(fake.monaco, 1000)

    fake.disposeModel(fake.models[0])
    fake.models.push(createModel('javascript'))
    vi.advanceTimersByTime(1000)
    expect(fake.typescriptDefaults.setCompilerOptions).not.toHaveBeenCalled()
    fake.changeLanguage(fake.models[0], 'markdown')
    vi.advanceTimersByTime(999)
    expect(fake.javascriptDefaults.setCompilerOptions).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(fake.javascriptDefaults.setCompilerOptions).toHaveBeenCalledTimes(1)
  })

  it('cancels the pending stop and model subscriptions on cleanup', () => {
    vi.useFakeTimers()
    const fake = createFakeMonaco(['javascript'])
    const dispose = installMonacoTsWorkerIdleStop(fake.monaco, 1000)
    fake.disposeModel(fake.models[0])
    dispose()
    vi.advanceTimersByTime(1000)
    expect(fake.javascriptDefaults.setCompilerOptions).not.toHaveBeenCalled()
    for (const event of [
      fake.monaco.editor.onWillDisposeModel,
      fake.monaco.editor.onDidChangeModelLanguage
    ]) {
      expect(event.mock.results[0].value.dispose).toHaveBeenCalledOnce()
    }
  })
})
