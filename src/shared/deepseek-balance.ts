import { z } from 'zod'

const Amount = z
  .string()
  .max(128)
  .regex(/^-?\d+(?:\.\d+)?$/)
const BalanceRow = z.object({
  currency: z.enum(['CNY', 'USD']),
  total_balance: Amount,
  granted_balance: Amount,
  topped_up_balance: Amount
})

export const DeepSeekBalanceResponse = z
  .object({ is_available: z.boolean(), balance_infos: z.array(BalanceRow).max(2) })
  .refine((value) => !value.is_available || value.balance_infos.length > 0)
  .refine(
    (value) =>
      new Set(value.balance_infos.map((row) => row.currency)).size === value.balance_infos.length
  )

export type DeepSeekBalance = z.infer<typeof DeepSeekBalanceResponse>

export type DeepSeekAccountStatus = {
  supported: boolean
  configured: boolean
  ownerId: string | null
  protection: 'sealed' | null
}

export const DEEPSEEK_BALANCE_CAPABILITY = 'accounts.deepseek-balance.v1' as const

export function unsupportedDeepSeekAccount(): DeepSeekAccountStatus {
  return { supported: false, configured: false, ownerId: null, protection: null }
}

export function formatDeepSeekBalance(balance: DeepSeekBalance): string {
  return balance.balance_infos.map((row) => `${row.currency} ${row.total_balance}`).join(' · ')
}
