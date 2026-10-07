import type { Duplex } from 'node:stream'
import type { ClientOptions } from 'ws'

type RemoteRuntimeSocketConnector = () => Duplex

const connectors = new Map<string, RemoteRuntimeSocketConnector>()

/**
 * Routes sockets for `endpoint` through an in-process stream instead of a TCP/TLS connect.
 * Why: Relay-routed environments are reached through a local bridge that owns the Relay
 * leg, so the existing remote-runtime transports keep their framing, retries and errors.
 */
export function registerRemoteRuntimeSocketConnector(
  endpoint: string,
  connector: RemoteRuntimeSocketConnector
): () => void {
  connectors.set(endpoint, connector)
  return () => {
    if (connectors.get(endpoint) === connector) {
      connectors.delete(endpoint)
    }
  }
}

export function withRemoteRuntimeSocketConnector<TOptions extends ClientOptions>(
  endpoint: string,
  options: TOptions
): TOptions {
  const connector = connectors.get(endpoint)
  if (!connector) {
    return options
  }
  return {
    ...options,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: ws passes this to http.request, which only reads and writes bytes on the returned stream; any Duplex works, a net.Socket is not required.
    createConnection: connector as unknown as NonNullable<ClientOptions['createConnection']>
  }
}
