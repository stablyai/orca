export type TailnetPeerSuggestion = {
  hostName: string
  /** MagicDNS name without the trailing dot, e.g. `my-mac.tail1234.ts.net`.
   *  Empty when MagicDNS is disabled on the tailnet. */
  dnsName: string
  /** First Tailscale IPv4 (100.64.0.0/10) of the peer, if any. */
  ipv4: string | null
  os: string
  online: boolean
  /** Peer advertises Tailscale SSH host keys, so tailscaled itself serves SSH. */
  tailscaleSsh: boolean
}

export type TailnetPeerDiscovery = {
  /** False when the Tailscale CLI is missing or `tailscale status` failed. */
  available: boolean
  peers: TailnetPeerSuggestion[]
}
