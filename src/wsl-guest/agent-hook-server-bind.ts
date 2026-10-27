import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { listenForAgentHooks } from '../shared/agent-hook-startup'

export async function bindRelayHookServer(options: {
  preferredPort: number
  isCurrent: () => boolean
  handleRequest: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  setServer: (server: Server | null) => void
  setPort: (port: number) => void
  onFallback: () => void
}): Promise<void> {
  const listenOn = async (port: number) => {
    const server = createServer(options.handleRequest)
    options.setServer(server)
    try {
      await listenForAgentHooks(
        server,
        port,
        options.isCurrent,
        () => {
          const address = server.address()
          if (address && typeof address === 'object') {
            options.setPort(address.port)
          }
        },
        (error) => process.stderr.write(`[relay-hook-server] server error: ${error.message}\n`)
      )
    } catch (error) {
      options.setServer(null)
      throw error
    }
  }
  try {
    await listenOn(options.preferredPort)
  } catch (error) {
    if (!options.isCurrent()) {
      return
    }
    // A busy preferred port still permits endpoint-file discovery on an ephemeral port.
    if (
      options.preferredPort > 0 &&
      error instanceof Error &&
      'code' in error &&
      error.code === 'EADDRINUSE'
    ) {
      options.onFallback()
      await listenOn(0)
    } else {
      throw error
    }
  }
}
