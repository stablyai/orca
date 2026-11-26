let version = 0
const listeners = new Set<() => void>()
export const pipelineRetentionVersion = () => version
export function subscribePipelineRetention(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
export function publishPipelineRetentionChange() {
  version++
  listeners.forEach((listener) => listener())
}
