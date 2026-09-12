// Shapes for the console.claude.ai balance API.

export type ConsoleApiOrganizationBalance = {
  id: string
  balance_in_cents: number
  spending_metrics?: {
    spend_rate_cents_per_hour?: number
    projected_spend_per_day_cents?: number
  }
}

export type ConsoleBalance = {
  organization_id: string
  balance_in_cents: number
  spend_rate_cents_per_hour?: number
  last_fetched_at: number
}
