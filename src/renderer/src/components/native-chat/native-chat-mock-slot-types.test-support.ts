// Typed starting values for mutable mock slots, so a test can later assign the wider type.

export function nullable<T>(): T | null {
  return null
}

export function widened<T>(value: T): T {
  return value
}

export function absent<T>(): T | undefined {
  return undefined
}
