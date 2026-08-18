export type SetupHookApproval = {
  kind: 'setup'
  token: string
  contentHash: string
}

export type SetupHookTrust = {
  contentHash: string
  scriptContent: string
  approvalToken?: string
}

const SHA256_HEX = /^[a-f0-9]{64}$/

export function parseSetupHookApproval(value: unknown): SetupHookApproval | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const candidate = value as Record<string, unknown>
  if (
    candidate.kind !== 'setup' ||
    typeof candidate.token !== 'string' ||
    candidate.token.length < 1 ||
    candidate.token.length > 200 ||
    typeof candidate.contentHash !== 'string' ||
    !SHA256_HEX.test(candidate.contentHash)
  ) {
    return undefined
  }
  return {
    kind: 'setup',
    token: candidate.token,
    contentHash: candidate.contentHash
  }
}

export function parseSetupHookTrust(value: unknown): SetupHookTrust | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const candidate = value as Record<string, unknown>
  if (
    typeof candidate.contentHash !== 'string' ||
    !SHA256_HEX.test(candidate.contentHash) ||
    typeof candidate.scriptContent !== 'string' ||
    candidate.scriptContent.length < 1 ||
    (candidate.approvalToken !== undefined &&
      (typeof candidate.approvalToken !== 'string' ||
        candidate.approvalToken.length < 1 ||
        candidate.approvalToken.length > 200))
  ) {
    return undefined
  }
  return {
    contentHash: candidate.contentHash,
    scriptContent: candidate.scriptContent,
    ...(candidate.approvalToken ? { approvalToken: candidate.approvalToken } : {})
  }
}

export function setupHookApprovalFromTrust(
  trust: SetupHookTrust | null | undefined
): SetupHookApproval | undefined {
  if (!trust?.approvalToken || !SHA256_HEX.test(trust.contentHash)) {
    return undefined
  }
  return { kind: 'setup', token: trust.approvalToken, contentHash: trust.contentHash }
}
