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
  const timers = new Map<string, ReturnType<typeof setTimeout>>()

  const schedule = (languageId: string): void => {
    const timer = timers.get(languageId)
    if (timer !== undefined) {
      clearTimeout(timer)
    }
    timers.set(
      languageId,
      setTimeout(() => {
        timers.delete(languageId)
        if (monaco.editor.getModels().some((model) => model.getLanguageId() === languageId)) {
          return
        }
        const defaults =
          languageId === 'typescript'
            ? monaco.typescript.typescriptDefaults
            : monaco.typescript.javascriptDefaults
        // Each language owns its worker; resetting options releases only the idle one.
        defaults.setCompilerOptions(defaults.getCompilerOptions())
      }, delayMs)
    )
  }

  const subscriptions = [
    monaco.editor.onWillDisposeModel((model) => {
      const languageId = model.getLanguageId()
      if (TS_LANGUAGE_IDS.has(languageId)) {
        schedule(languageId)
      }
    }),
    monaco.editor.onDidChangeModelLanguage(({ model, oldLanguage }) => {
      if (TS_LANGUAGE_IDS.has(oldLanguage) && oldLanguage !== model.getLanguageId()) {
        schedule(oldLanguage)
      }
    })
  ]
  return () => {
    for (const timer of timers.values()) {
      clearTimeout(timer)
    }
    timers.clear()
    for (const subscription of subscriptions) {
      subscription.dispose()
    }
  }
}
