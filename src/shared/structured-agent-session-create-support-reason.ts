/**
 * Why a host refused to create a structured session there. The vocabulary is shared because the
 * client renders it and only the executing host can decide it.
 */
export type StructuredAgentSessionCreateSupportReason = 'agent' | 'remote' | 'wsl' | 'login'

/**
 * The executing host has no provider login. Nothing a client holds can substitute for it — only a
 * person on that host can sign in — so the refusal says that instead of offering a retry.
 */
export const PROVIDER_LOGIN_REQUIRED_SUPPORT_REASON =
  'login' satisfies StructuredAgentSessionCreateSupportReason
