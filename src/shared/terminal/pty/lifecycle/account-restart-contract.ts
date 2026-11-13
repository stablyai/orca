export const ACCOUNT_RESTART_CAPABILITY = 'terminal.account-restart.v1'
const PREFIX = 'terminal_account_restart_v1:'

export type AccountRestartOwner =
  | { kind: 'endpoint'; ptyId: string; incarnationId: string; bindingGeneration: number }
  | { kind: 'empty'; bindingGeneration: number }

export type AccountRestartCondition = {
  requestId: string
  attemptId: string
  hostEpoch: string
  pane: { worktreeId: string; tabId: string; leafId: string; tabCreatedAt: number }
  expected: AccountRestartOwner
}

export type AccountRestartReceipt = {
  v: 1
  requestId: string
  attemptId: string
  stop: 'not-started' | 'confirmed-retired' | 'unknown'
  outcome?: 'terminal' | 'unknown'
  current?: { kind: 'original' | 'empty'; bindingGeneration: number; incarnationId?: string }
}

import { z } from 'zod'
const token = z.string().min(1).max(128)
const generation = z.number().int().nonnegative()
export const AccountRestartConditionSchema = z.object({
  requestId: token,
  attemptId: token,
  hostEpoch: token,
  pane: z.object({
    worktreeId: z.string().min(1).max(32768),
    tabId: token,
    leafId: z.uuid(),
    tabCreatedAt: z.number().finite()
  }),
  expected: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('endpoint'),
      ptyId: z.string().min(1).max(32768),
      incarnationId: token,
      bindingGeneration: generation
    }),
    z.object({ kind: z.literal('empty'), bindingGeneration: generation })
  ])
})
const ReceiptSchema = z.object({
  v: z.literal(1),
  requestId: token,
  attemptId: token,
  stop: z.enum(['not-started', 'confirmed-retired', 'unknown']),
  outcome: z.enum(['terminal', 'unknown']).default('unknown'),
  current: z
    .object({
      kind: z.enum(['original', 'empty']),
      bindingGeneration: generation,
      incarnationId: token.optional()
    })
    .optional()
})
export function readAccountRestartCondition(value: unknown): AccountRestartCondition | undefined {
  const parsed = AccountRestartConditionSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}
export function parseAccountRestartReceipt(value: unknown): AccountRestartReceipt | undefined {
  const parsed = ReceiptSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

export function formatAccountRestartFailure(
  message: string,
  receipt: AccountRestartReceipt
): string {
  const bytes = new TextEncoder().encode(JSON.stringify(receipt))
  const encoded = btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
  return `${message} ${PREFIX}${encoded}`
}

const receiptSuffix = new RegExp(`(?:^|[\\t ]+)${PREFIX}[\\w-]+[\\t ]*$`, 'gm')
export function withoutAccountRestartReceipt(message: string): string {
  return message.replace(receiptSuffix, '').trimEnd()
}

export function readAccountRestartReceipt(error: unknown): AccountRestartReceipt | undefined {
  if (
    error &&
    typeof error === 'object' &&
    'response' in error &&
    error.response &&
    typeof error.response === 'object' &&
    'error' in error.response
  ) {
    const failure = error.response.error
    if (
      failure &&
      typeof failure === 'object' &&
      'data' in failure &&
      failure.data &&
      typeof failure.data === 'object' &&
      'accountRestart' in failure.data
    ) {
      return parseAccountRestartReceipt(failure.data.accountRestart)
    }
  }
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const index = message.lastIndexOf(PREFIX)
  if (index === -1) {
    return undefined
  }
  const encoded = message.slice(index + PREFIX.length).trim()
  if (!/^[\w-]+$/.test(encoded) || encoded.length > 1400) {
    return undefined
  }
  try {
    const bytes = Uint8Array.from(atob(encoded.replaceAll('-', '+').replaceAll('_', '/')), (c) =>
      c.charCodeAt(0)
    )
    if (bytes.length > 1024) {
      return undefined
    }
    return parseAccountRestartReceipt(JSON.parse(new TextDecoder().decode(bytes)))
  } catch {
    return undefined
  }
}

export type AccountRestartSnapshot = {
  hostEpoch: string
  bindingGeneration: number
  tabCreatedAt: number
  owner: { ptyId: string; incarnationId: string } | null
}
export const AccountRestartSnapshotSchema = z.object({
  hostEpoch: token,
  bindingGeneration: generation,
  tabCreatedAt: z.number().finite(),
  owner: z.object({ ptyId: z.string().min(1), incarnationId: token }).nullable()
})
