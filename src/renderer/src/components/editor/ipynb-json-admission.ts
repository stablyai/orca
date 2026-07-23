import { assertJsonTextStructureWithinLimits } from '../../../../shared/json-text-structure-limit'

export const IPYNB_MEMORY_LIMITS = {
  sourceCodeUnits: 50 * 1024 * 1024,
  structuralTokens: 500_000,
  nestingDepth: 256,
  cells: 1000,
  outputs: 10_000,
  displayItems: 20_000,
  multilineParts: 100_000
} as const

export type IpynbMemoryLimits = Readonly<{
  sourceCodeUnits: number
  structuralTokens: number
  nestingDepth: number
  cells: number
  outputs: number
  displayItems: number
  multilineParts: number
}>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function assertIpynbJsonWithinMemoryLimits(
  content: string,
  limits: IpynbMemoryLimits = IPYNB_MEMORY_LIMITS
): void {
  if (content.length > limits.sourceCodeUnits) {
    throw new Error('Notebook exceeds the safe source size limit')
  }

  assertJsonTextStructureWithinLimits(content, {
    structuralTokens: limits.structuralTokens,
    nestingDepth: limits.nestingDepth
  })
}

export function assertIpynbShapeWithinMemoryLimits(
  cells: readonly unknown[],
  limits: IpynbMemoryLimits = IPYNB_MEMORY_LIMITS
): void {
  if (cells.length > limits.cells) {
    throw new Error('Notebook exceeds the safe cell limit')
  }

  let outputCount = 0
  let displayItemCount = 0
  let multilinePartCount = 0
  const claimMultilineParts = (value: unknown): void => {
    if (!Array.isArray(value)) {
      return
    }
    multilinePartCount += value.length
    if (multilinePartCount > limits.multilineParts) {
      throw new Error('Notebook exceeds the safe multiline fragment limit')
    }
  }

  for (const cell of cells) {
    if (!isRecord(cell)) {
      continue
    }
    claimMultilineParts(cell.source)
    if (!Array.isArray(cell.outputs)) {
      continue
    }
    outputCount += cell.outputs.length
    if (outputCount > limits.outputs) {
      throw new Error('Notebook exceeds the safe output limit')
    }
    for (const output of cell.outputs) {
      if (!isRecord(output)) {
        continue
      }
      claimMultilineParts(output.text)
      claimMultilineParts(output.traceback)
      if (!isRecord(output.data)) {
        continue
      }
      for (const key in output.data) {
        if (!Object.prototype.hasOwnProperty.call(output.data, key)) {
          continue
        }
        displayItemCount += 1
        if (displayItemCount > limits.displayItems) {
          throw new Error('Notebook exceeds the safe display item limit')
        }
      }
    }
  }
}
