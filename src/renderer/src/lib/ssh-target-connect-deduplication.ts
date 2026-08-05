import type { SshConnectionState } from '../../../shared/ssh-types'

const pendingConnects = new Map<string, Promise<SshConnectionState | null>>()

export function connectSshTargetDeduplicated(
  targetId: string,
  connect: () => Promise<SshConnectionState | null>
): Promise<SshConnectionState | null> {
  const pending = pendingConnects.get(targetId)
  if (pending) {
    return pending
  }

  let next: Promise<SshConnectionState | null>
  try {
    next = connect()
  } catch (error) {
    next = Promise.reject(error)
  }
  const tracked = next.finally(() => {
    if (pendingConnects.get(targetId) === tracked) {
      pendingConnects.delete(targetId)
    }
  })
  pendingConnects.set(targetId, tracked)
  return tracked
}
