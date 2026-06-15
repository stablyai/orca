/**
 * Error type for the remote-runtime client, split out from
 * `remote-runtime-client.ts` so type-only consumers can reference it without
 * pulling in that module's `ws`/`tweetnacl` value imports. Mobile reaches this
 * type transitively (runtime-types → shared-control-types) and its typecheck
 * has no Node-only deps installed.
 */
export class RemoteRuntimeClientError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'RemoteRuntimeClientError'
    this.code = code
  }
}
