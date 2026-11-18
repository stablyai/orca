import { vi } from 'vitest'

export function holdPhysicalCloseTasks() {
  const tasks: (() => void)[] = []
  const timer = globalThis.setTimeout
  vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
    // Observe the installed FocusScope cleanup task; never invoke the consumer callback directly.
    if (callback.toString().includes('unmountEvent')) {
      tasks.push(() => callback(...args))
      return timer(() => {}, 0)
    }
    return timer(callback, delay, ...args)
  })
  return tasks
}
