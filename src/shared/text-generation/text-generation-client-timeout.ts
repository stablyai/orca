// Clients wait past the host's 60 s generation limit so its own timeout error arrives instead of a transport one.
export const TEXT_GENERATION_CLIENT_TIMEOUT_MS = 75_000
