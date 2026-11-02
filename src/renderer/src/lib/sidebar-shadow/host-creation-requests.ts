// Why not pendingWorktreeCreations: a pending entry also covers preflight the host never sees and
// the window's own work after the host replied, so only the request itself matches the host's span.
type HostCreationRequest = { repoId: string; inFlight: boolean }

// One entry per create this session; settled ones stay so a host entry that outlives its request
// still has an owner to be compared against.
const requests = new Map<string, HostCreationRequest>()

/** Runs one create request to this window's own host, remembering it under its creationId. */
export async function requestCreationFromHost<T>(
  creation: { creationId?: string; repoId: string },
  send: () => Promise<T>
): Promise<T> {
  if (!creation.creationId) {
    return send()
  }
  const request: HostCreationRequest = { repoId: creation.repoId, inFlight: true }
  requests.set(creation.creationId, request)
  try {
    return await send()
  } finally {
    request.inFlight = false
  }
}

export function readHostCreationRequests(): ReadonlyMap<string, Readonly<HostCreationRequest>> {
  return requests
}
