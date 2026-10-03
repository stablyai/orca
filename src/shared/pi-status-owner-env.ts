/** Set to the PID of the Pi-family process that reports its pane's status; descendants inherit it. */
export const PI_STATUS_OWNER_ENV_KEYS = [
  'ORCA_PI_STATUS_OWNED',
  'ORCA_PRIME_AGENT_STATUS_OWNED'
] as const
