import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'

// xAI documents prepaid credit top-ups under "Additional usage credits" on this page.
const GROK_BILLING_URL = 'https://grok.com/dashboard/billing'

/** A sign-in and payment page: always the system browser, never a workspace browser agents can drive. */
export function openGrokBillingPage(): void {
  openAppHttpLink(GROK_BILLING_URL, { destination: 'system' })
}
