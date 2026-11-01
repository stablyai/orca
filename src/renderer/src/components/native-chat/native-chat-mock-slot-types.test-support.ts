export function nullable<T>(): T | null {
  return null
}

export function widened<T>(value: T): T {
  return value
}

export function absent<T>(): T | undefined {
  return undefined
}
