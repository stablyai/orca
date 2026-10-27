#!/usr/bin/env node
import { connect } from 'node:net'
import { BrowserNetworkTunnelSession } from '../main/browser/browser-network-tunnel-session'
import {
  BrowserNetworkTunnelStreamFrameDecoder,
  BrowserNetworkTunnelStreamFrameWriter
} from '../shared/browser-network-tunnel-stream-framing'
import { WSL_BROWSER_NETWORK_RELAY_SENTINEL } from '../shared/wsl-browser-network-relay-contract'

function main(): void {
  let shuttingDown = false
  const shutdown = (): void => {
    if (shuttingDown) {
      return
    }
    shuttingDown = true
    decoder.close()
    writer.close()
    session.close()
    process.exitCode = 0
  }
  const writer = new BrowserNetworkTunnelStreamFrameWriter(
    (bytes, callback) => process.stdout.write(bytes, callback),
    shutdown
  )
  const session = new BrowserNetworkTunnelSession({
    tunnelGeneration: 1,
    connect: (target) => connect({ ...target, allowHalfOpen: true }),
    sendBinary: (frame) => writer.send(frame),
    onClose: shutdown
  })
  const decoder = new BrowserNetworkTunnelStreamFrameDecoder(
    (frame) => session.handleBinary(frame),
    shutdown
  )

  process.stdin.on('data', (bytes: Buffer) => decoder.feed(bytes))
  process.stdin.on('end', shutdown)
  process.stdin.on('error', shutdown)
  process.stdout.on('error', shutdown)
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
  process.stderr.write(WSL_BROWSER_NETWORK_RELAY_SENTINEL)
}

main()
