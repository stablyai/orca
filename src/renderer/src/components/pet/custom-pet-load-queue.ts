type QueuedCustomPetLoad = {
  run: () => Promise<unknown>
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

export const MAX_CONCURRENT_CUSTOM_PET_LOADS = 2
export const MAX_PENDING_CUSTOM_PET_LOADS = 16

export class CustomPetLoadQueue {
  private active = 0
  private pending = 0
  private readonly queue: QueuedCustomPetLoad[] = []

  run<T>(task: () => Promise<T>): Promise<T> {
    if (this.pending >= MAX_PENDING_CUSTOM_PET_LOADS) {
      return Promise.reject(
        new Error(`Too many pending custom pet loads (max ${MAX_PENDING_CUSTOM_PET_LOADS}).`)
      )
    }
    this.pending += 1
    const promise = new Promise<unknown>((resolve, reject) => {
      this.queue.push({ run: task, resolve, reject })
      this.pump()
    })
    return promise as Promise<T>
  }

  inspect(): { active: number; pending: number } {
    return { active: this.active, pending: this.pending }
  }

  private pump(): void {
    while (this.active < MAX_CONCURRENT_CUSTOM_PET_LOADS) {
      const next = this.queue.shift()
      if (!next) {
        return
      }
      this.active += 1
      let load: Promise<unknown>
      try {
        load = next.run()
      } catch (error) {
        load = Promise.reject(error)
      }
      void load.then(next.resolve, next.reject).finally(() => {
        this.active -= 1
        this.pending -= 1
        this.pump()
      })
    }
  }
}
