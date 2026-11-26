#!/usr/bin/env node
import { connect } from 'node:net'
import { BrowserNetworkTunnelSession } from '../main/browser/network/tunnels/browser-network-tunnel-session'
import {
  BROWSER_NETWORK_RELAY_FLOW_CONTROL,
  BROWSER_NETWORK_RELAY_WRITER_LIMITS
} from '../main/browser/network/tunnels/browser-network-tunnel-stream-state'
import {
  BrowserNetworkTunnelStreamFrameDecoder,
  BrowserNetworkTunnelStreamFrameWriter
} from '../shared/browser/network/tunnels/browser-network-tunnel-stream-framing'
import { WSL_BROWSER_NETWORK_RELAY_SENTINEL } from '../shared/browser/network/tunnels/wsl-browser-network-relay-contract'

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
    shutdown,
    BROWSER_NETWORK_RELAY_WRITER_LIMITS
  )
  const session = new BrowserNetworkTunnelSession({
    tunnelGeneration: 1,
    flowControl: BROWSER_NETWORK_RELAY_FLOW_CONTROL,
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
  // On stdout, so the desktop can skip anything a login profile printed before the first frame.
  process.stdout.write(WSL_BROWSER_NETWORK_RELAY_SENTINEL)
}

main()
