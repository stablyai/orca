export type AgentLaunchAccountReceipt = {
  provider: 'codex'
  requested: string
  effective: { id: string | null; email: string | null }
}

export const CODEX_LAUNCH_ACCOUNT_RUNTIME_CAPABILITY = 'codex.launch-account.v1' as const

export function codexAccountSpawnOptions(accountId: string | null | undefined): {
  codexAccountId?: string | null
} {
  return accountId === undefined ? {} : { codexAccountId: accountId }
}

export function assertNewCodexAccountPane(
  accountId: string | null | undefined,
  existingPane: unknown
): void {
  if (accountId !== undefined && existingPane) {
    throw new Error('--account cannot reuse a live or pending terminal pane.')
  }
}

export function assertCodexAccountLaunchRequest(args: {
  account?: string
  agent?: string
  terminal?: string
  on?: string
}): void {
  if (args.account === undefined) {
    return
  }
  if (args.terminal) {
    throw new Error('--account cannot combine with existing-terminal reuse.')
  }
  if (args.on) {
    throw new Error(
      '--account does not support --on federation; connect directly to the execution runtime.'
    )
  }
  if (args.agent !== 'codex') {
    throw new Error('--account requires --agent codex; other providers are unsupported.')
  }
}

export function isAgentLaunchAccountReceipt(value: unknown): value is AgentLaunchAccountReceipt {
  if (!value || typeof value !== 'object') {
    return false
  }
  if (
    !('provider' in value) ||
    value.provider !== 'codex' ||
    !('requested' in value) ||
    typeof value.requested !== 'string' ||
    !('effective' in value) ||
    !value.effective ||
    typeof value.effective !== 'object'
  ) {
    return false
  }
  const effective = value.effective
  return (
    'id' in effective &&
    (effective.id === null || typeof effective.id === 'string') &&
    'email' in effective &&
    (effective.email === null || typeof effective.email === 'string')
  )
}
