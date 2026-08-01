import { timingSafeEqual } from 'node:crypto'

export function timingSafeTokenCompare(expected: string, actual: unknown): boolean {
  const actualIsString = typeof actual === 'string'
  const expectedBytes = Buffer.from(expected, 'utf8')
  const actualString = actualIsString ? actual : ''
  const actualBytes = Buffer.from(actualString.slice(0, expected.length + 1), 'utf8')
  const fixedWidthActual = Buffer.alloc(expectedBytes.length)
  actualBytes.copy(fixedWidthActual, 0, 0, expectedBytes.length)
  const contentsMatch = timingSafeEqual(expectedBytes, fixedWidthActual)
  return (
    actualIsString &&
    actualString.length === expected.length &&
    actualBytes.length === expectedBytes.length &&
    contentsMatch
  )
}
