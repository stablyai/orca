export type DictationConversationTarget = {
  onAudio?: (samples: Float32Array, sampleRate: number) => void
  acceptsCapture?: () => boolean
  onPartial: (text: string) => void
  onFinal: (text: string) => void
  onStopped: () => void
  onError: (message: string) => void
}

const targets = new WeakMap<Element, DictationConversationTarget>()

export function registerDictationConversationTarget(
  element: Element,
  target: DictationConversationTarget
): () => void {
  let current = true
  const guarded: DictationConversationTarget = {
    onAudio: (samples, rate) => current && target.onAudio?.(samples, rate),
    acceptsCapture: () => current && (target.acceptsCapture?.() ?? true),
    onPartial: (text) => current && target.onPartial(text),
    onFinal: (text) => current && target.onFinal(text),
    onStopped: () => current && target.onStopped(),
    onError: (message) => current && target.onError(message)
  }
  targets.set(element, guarded)
  return () => {
    current = false
    if (targets.get(element) === guarded) {
      targets.delete(element)
    }
  }
}

export function getDictationConversationTarget(
  element: Element
): DictationConversationTarget | null {
  return targets.get(element) ?? null
}
