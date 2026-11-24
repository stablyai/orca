// A runtime without this keeps no ClickUp links and has no clickup.* methods, so older hosts must be refused up front.
export const CLICKUP_RUNTIME_CAPABILITY = 'clickup.v1' as const
