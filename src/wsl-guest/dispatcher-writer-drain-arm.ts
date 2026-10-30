type DrainRegistration = { registered: boolean; remove: () => void }

// registerDrain may fire synchronously; recheck the arm before retaining its remover or it could cancel a newer registration.
export class DispatcherWriterDrainArm {
  private armed = false
  private remove: (() => void) | null = null

  get isArmed(): boolean {
    return this.armed
  }

  arm(register: (onDrain: () => void) => DrainRegistration, onDrain: () => void): void {
    if (this.armed) {
      return
    }
    this.armed = true
    const registration = register(onDrain)
    if (!registration.registered) {
      this.armed = false
    } else if (this.armed) {
      this.remove = registration.remove
    } else {
      registration.remove()
    }
  }

  disarm(): void {
    this.armed = false
    const remove = this.remove
    this.remove = null
    remove?.()
  }
}
