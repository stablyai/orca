// Monaco's TS WorkerManager has no idle stop, so one viewed .ts file kept a ~40 MB worker alive for the session.
export const TS_WORKER_IDLE_STOP_MS = 60_000

const TS_LANGUAGE_IDS = new Set(['typescript', 'javascript'])

type Model = { getLanguageId(): string }
type ModelEvent<Event> = (listener: (event: Event) => void) => { dispose(): void }
type LanguageDefaults<Options> = {
  getCompilerOptions(): Options
  setCompilerOptions(options: Options): void
}
/** The slice of the monaco namespace this reads; the real namespace satisfies it structurally. */
export type MonacoTsWorkerHost<Options> = {
  editor: {
    getModels(): readonly Model[]
    onWillDisposeModel: ModelEvent<Model>
    onDidChangeModelLanguage: ModelEvent<{ model: Model; oldLanguage: string }>
  }
  typescript: {
    typescriptDefaults: LanguageDefaults<Options>
    javascriptDefaults: LanguageDefaults<Options>
  }
}

export function installMonacoTsWorkerIdleStop<Options>(
  monaco: MonacoTsWorkerHost<Options>,
  delayMs = TS_WORKER_IDLE_STOP_MS
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  const hasTsModels = (): boolean =>
    monaco.editor.getModels().some((model) => TS_LANGUAGE_IDS.has(model.getLanguageId()))

  const schedule = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
    }
    timer = setTimeout(() => {
      timer = null
      if (hasTsModels()) {
        return
      }
      // Re-setting options fires onDidChange, which disposes the worker; the next TS model starts a fresh one.
      for (const defaults of [
        monaco.typescript.typescriptDefaults,
        monaco.typescript.javascriptDefaults
      ]) {
        defaults.setCompilerOptions(defaults.getCompilerOptions())
      }
    }, delayMs)
  }

  const subscriptions = [
    monaco.editor.onWillDisposeModel((model) => {
      if (TS_LANGUAGE_IDS.has(model.getLanguageId())) {
        schedule()
      }
    }),
    monaco.editor.onDidChangeModelLanguage(({ model, oldLanguage }) => {
      if (TS_LANGUAGE_IDS.has(oldLanguage) && !TS_LANGUAGE_IDS.has(model.getLanguageId())) {
        schedule()
      }
    })
  ]
  return () => {
    if (timer !== null) {
      clearTimeout(timer)
    }
    for (const subscription of subscriptions) {
      subscription.dispose()
    }
  }
}
