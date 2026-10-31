import { z } from 'zod'
import { SlugRepo } from '../rpc-contract/github-repo-target-params'
import { ExpectedRuntimeSourceSchema } from '../runtime-rpc-envelope'

const methods = new Set([
  'github.workItemDetails',
  'github.updateIssue',
  'github.listLabels',
  'github.listAssignableUsers'
])
const exactShape = z.object({
  ownerRepo: SlugRepo,
  expectedRuntimeSource: ExpectedRuntimeSourceSchema
})

// Only the complete opt-in pair promises enforcement; old independently optional fields stay optional.
export function classifyExactGitHubOperation(method: string, params: unknown, envelope: unknown) {
  if (
    !methods.has(method) ||
    !isRecord(params) ||
    !isRecord(envelope) ||
    !Object.hasOwn(params, 'ownerRepo') ||
    !Object.hasOwn(envelope, 'expectedRuntimeSource')
  ) {
    return null
  }
  const parsed = exactShape.safeParse({
    ownerRepo: params.ownerRepo,
    expectedRuntimeSource: envelope.expectedRuntimeSource
  })
  if (!parsed.success) {
    throw new Error('Unable to identify the GitHub operation. Open the item again and try again.')
  }
  return parsed.data
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
