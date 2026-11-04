import { loadOniguruma } from '../syntax-highlighting/oniguruma'
import type { PluginGrammarResponse, PluginGrammarWorkerMessage } from './plugin-grammar-protocol'
import {
  compilePluginGrammar,
  onigLibrary,
  tokenizePluginGrammarDocument
} from './plugin-grammar-tokenization'

// Why a worker: one regex scan cannot be interrupted, so a plugin grammar runs where the
// renderer can terminate it instead of freezing the window.
let compiled: ReturnType<typeof compilePluginGrammar> = null
let activeId: number | null = null
let cancelledActive = false

function send(response: PluginGrammarResponse, transfer: Transferable[] = []): void {
  globalThis.postMessage(response, { transfer })
}

globalThis.onmessage = async (event: MessageEvent<PluginGrammarWorkerMessage>): Promise<void> => {
  const message = event.data
  if (message.type === 'init') {
    try {
      compiled = compilePluginGrammar(
        message.scopeName,
        message.grammars,
        onigLibrary(await loadOniguruma())
      )
    } catch {
      compiled = null
    }
    send({ type: 'ready', ok: compiled !== null })
    return
  }
  if (message.type === 'cancel') {
    // Why only the running job: the client sends one job at a time, so any other id is done.
    cancelledActive ||= message.id === activeId
    return
  }
  const { id } = message
  activeId = id
  cancelledActive = false
  try {
    const tokens = compiled
      ? await tokenizePluginGrammarDocument(compiled.grammar, message.text, {
          progress: () => send({ id, type: 'progress' }),
          cancelled: () => cancelledActive
        })
      : null
    if (tokens) {
      send({ id, type: 'complete', ...tokens }, [tokens.data.buffer])
    } else {
      send({ id, type: 'unavailable' })
    }
  } catch {
    // Why no detail: errors could echo grammar patterns or document text.
    send({ id, type: 'unavailable' })
  } finally {
    activeId = null
  }
}
