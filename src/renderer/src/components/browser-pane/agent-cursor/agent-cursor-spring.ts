export type SpringConfig = { response: number; damping: number }

// Response (s) and damping per channel, matched to the measured feel of ChatGPT's agent cursor.
export const VISIBILITY: SpringConfig = { response: 0.42, damping: 0.86 }
export const POSITION: SpringConfig = { response: 0.19, damping: 0.9 }
export const HEADING: SpringConfig = { response: 0.12, damping: 0.9 }
export const STRETCH: SpringConfig = { response: 0.2, damping: 0.85 }
export const PROGRESS_DAMPING = 0.9
export const LEAN: SpringConfig = { response: 0.055, damping: 0.82 }
export const SQUASH_SPRING: SpringConfig = { response: 0.12, damping: 0.86 }

/** Damped spring parameterised like SwiftUI's spring(response:dampingFraction:). */
export class Spring {
  velocity = 0
  target: number

  constructor(
    public value: number,
    public config: SpringConfig
  ) {
    this.target = value
  }

  snap(value: number): void {
    this.value = value
    this.target = value
    this.velocity = 0
  }

  /** Retargets an angle along the shorter way round. */
  aimAngle(degrees: number): void {
    let delta = (degrees - this.value) % 360
    if (delta > 180) {
      delta -= 360
    } else if (delta < -180) {
      delta += 360
    }
    this.target = this.value + delta
  }

  tick(dt: number): void {
    // Cap stiffness so a tiny response cannot destabilise the fixed step.
    const stiffness = Math.min((2 * Math.PI) ** 2 / this.config.response ** 2, 1 / (2 * dt * dt))
    const damping = 2 * Math.sqrt(stiffness) * this.config.damping
    const acceleration = stiffness * (this.target - this.value) - damping * this.velocity
    this.velocity += acceleration * dt
    this.value += this.velocity * dt
    if (this.settled()) {
      this.snap(this.target)
    }
  }

  settled(): boolean {
    return Math.abs(this.target - this.value) < 0.01 && Math.abs(this.velocity) < 0.06
  }
}
