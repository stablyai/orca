export function derivePipelinePrdLabel(prdIssueNumber: number): string {
  if (!Number.isInteger(prdIssueNumber) || prdIssueNumber <= 0) {
    throw new Error('Pipeline PRD issue number must be a positive integer')
  }
  return `pipeline:prd-${prdIssueNumber}`
}

export function validatePipelinePrdLabel(prdIssueNumber: number, pipelinePrdLabel: string): void {
  const expected = derivePipelinePrdLabel(prdIssueNumber)
  if (pipelinePrdLabel !== expected) {
    throw new Error(`Pipeline PRD label must be ${expected}`)
  }
}
