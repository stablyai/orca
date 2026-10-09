export type AgentSessionPermissionOrder = {
  /** Order of permission intent, committed with the options it orders. */
  permissionRevision?: number
}

export function isAgentSessionPermissionOrder(value: {
  permissionRevision?: unknown
}): value is AgentSessionPermissionOrder {
  const { permissionRevision: revision } = value
  return (
    revision === undefined ||
    (typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0)
  )
}
