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
    expect(fake.javascriptDefaults.setCompilerOptions).not.toHaveBeenCalled()
  })

  it.each(['typescript', 'javascript'])(
    'stops %s independently of the other language',
    (language) => {
      vi.useFakeTimers()
      const fake = createFakeMonaco(['typescript', 'javascript'])
      installMonacoTsWorkerIdleStop(fake.monaco, 1000)
      const closed = fake.models.find((model) => model.getLanguageId() === language)
      if (!closed) {
        throw new Error('Missing language model')
      }
      fake.disposeModel(closed)
      vi.advanceTimersByTime(1000)
      const stopped = language === 'typescript' ? fake.typescriptDefaults : fake.javascriptDefaults
      const retained = language === 'typescript' ? fake.javascriptDefaults : fake.typescriptDefaults
      expect(stopped.setCompilerOptions).toHaveBeenCalledOnce()
      expect(retained.setCompilerOptions).not.toHaveBeenCalled()
    }
  )

  it('keeps independent deadlines when both language workers lose their models', () => {
    vi.useFakeTimers()
    const fake = createFakeMonaco(['typescript', 'javascript'])
    installMonacoTsWorkerIdleStop(fake.monaco, 1000)
    fake.disposeModel(fake.models[0])
    vi.advanceTimersByTime(500)
    fake.disposeModel(fake.models[0])
    vi.advanceTimersByTime(500)
    expect(fake.typescriptDefaults.setCompilerOptions).toHaveBeenCalledOnce()
    expect(fake.javascriptDefaults.setCompilerOptions).not.toHaveBeenCalled()
    vi.advanceTimersByTime(500)
    expect(fake.javascriptDefaults.setCompilerOptions).toHaveBeenCalledOnce()
  })

  it('releases the old language worker after changing between TS and JS', () => {
    vi.useFakeTimers()
    const fake = createFakeMonaco(['typescript'])
    installMonacoTsWorkerIdleStop(fake.monaco, 1000)
    fake.changeLanguage(fake.models[0], 'javascript')
    vi.advanceTimersByTime(1000)
    expect(fake.typescriptDefaults.setCompilerOptions).toHaveBeenCalledOnce()
    expect(fake.javascriptDefaults.setCompilerOptions).not.toHaveBeenCalled()
  })

  it('rechecks reopened models of the same language and waits for their departure', () => {
    vi.useFakeTimers()
    const fake = createFakeMonaco(['typescript'])
    installMonacoTsWorkerIdleStop(fake.monaco, 1000)

    fake.disposeModel(fake.models[0])
    fake.models.push(createModel('typescript'))
    vi.advanceTimersByTime(1000)
    expect(fake.typescriptDefaults.setCompilerOptions).not.toHaveBeenCalled()
    fake.changeLanguage(fake.models[0], 'markdown')
    vi.advanceTimersByTime(999)
    expect(fake.typescriptDefaults.setCompilerOptions).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(fake.typescriptDefaults.setCompilerOptions).toHaveBeenCalledTimes(1)
    expect(fake.javascriptDefaults.setCompilerOptions).not.toHaveBeenCalled()
  })

  it('cancels the pending stop and model subscriptions on cleanup', () => {
    vi.useFakeTimers()
    const fake = createFakeMonaco(['typescript', 'javascript'])
    const dispose = installMonacoTsWorkerIdleStop(fake.monaco, 1000)
    fake.disposeModel(fake.models[0])
    fake.disposeModel(fake.models[0])
    dispose()
    vi.advanceTimersByTime(1000)
    expect(fake.javascriptDefaults.setCompilerOptions).not.toHaveBeenCalled()
    expect(fake.typescriptDefaults.setCompilerOptions).not.toHaveBeenCalled()
    for (const event of [
      fake.monaco.editor.onWillDisposeModel,
      fake.monaco.editor.onDidChangeModelLanguage
    ]) {
      expect(event.mock.results[0].value.dispose).toHaveBeenCalledOnce()
    }
  })
})
