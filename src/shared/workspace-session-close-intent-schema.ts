import { z } from 'zod'
import { clientHostedBrowserCloseIntentSchema } from './client-hosted-browser-close-intent'
import { pairedTerminalTabCloseIntentSchema } from './paired-terminal-tab-close-intent'
import { salvagedOptional, salvagingArray, salvagingRecord } from './zod-salvage'

/** The session fields holding closes this client owes a runtime environment, keyed by it. */
export const workspaceSessionCloseIntentFieldSchemas = {
  clientHostedBrowserCloseIntentsByEnvironment: salvagedOptional(
    'clientHostedBrowserCloseIntentsByEnvironment',
    salvagingRecord(z.string().min(1), salvagingArray(clientHostedBrowserCloseIntentSchema))
  ),
  pairedTerminalTabCloseIntentsByEnvironment: salvagedOptional(
    'pairedTerminalTabCloseIntentsByEnvironment',
    salvagingRecord(z.string().min(1), salvagingArray(pairedTerminalTabCloseIntentSchema))
  )
}
