export type RemoteRuntimeClientErrorLike = { code: string; message: string }

export function isRecoverableRemoteRuntimeConnectionError(
  error: RemoteRuntimeClientErrorLike
): boolean {
  return error.code === 'remote_runtime_unavailable' || error.code === 'runtime_timeout'
}
