// Keep zod/crypto out: protocol-version reaches bundles that cannot resolve them. The schema lives in ticket-exchange-contract.ts.

// Older hosts lack the method; clients exchange only when this is advertised and otherwise keep the pairing token.
export const PAIRING_TICKET_EXCHANGE_RUNTIME_CAPABILITY = 'pairing.ticket-exchange.v1' as const

export const PAIRING_TICKET_EXCHANGE_RUNTIME_CAPABILITIES = [
  PAIRING_TICKET_EXCHANGE_RUNTIME_CAPABILITY
] as const

export const EXCHANGE_PAIRING_TICKET_METHOD = 'pairing.exchangeTicket' as const
