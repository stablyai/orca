import { describe, expect, it, vi } from 'vitest'
import { MobileNetworkInterfaceSection } from './MobileNetworkInterfaceSection'

type ReactElementLike = {
  type: unknown
  props: Record<string, unknown>
}

function visit(node: unknown, cb: (node: ReactElementLike) => void): void {
  if (node == null || typeof node === 'string' || typeof node === 'number') {
    return
  }
  if (Array.isArray(node)) {
    node.forEach((entry) => visit(entry, cb))
    return
  }
  const element = node as ReactElementLike
  cb(element)
  if (element.props?.children) {
    visit(element.props.children, cb)
  }
}

function collectText(node: unknown): string {
  if (node == null || typeof node === 'boolean') {
    return ''
  }
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node)
  }
  if (Array.isArray(node)) {
    return node.map(collectText).join('')
  }
  const element = node as ReactElementLike
  return collectText(element.props?.children)
}

function findByAriaLabel(node: unknown, ariaLabel: string): ReactElementLike {
  let found: ReactElementLike | null = null
  visit(node, (entry) => {
    if (entry.props['aria-label'] === ariaLabel) {
      found = entry
    }
  })
  if (!found) {
    throw new Error(`element not found: ${ariaLabel}`)
  }
  return found
}

describe('MobileNetworkInterfaceSection', () => {
  it('shows refreshed tailnet interfaces and wires the refresh action', () => {
    const onRefreshNetworkInterfaces = vi.fn()
    const tree = MobileNetworkInterfaceSection({
      networkInterfaces: [
        { name: 'en0', address: '192.168.1.24' },
        { name: 'tailscale0', address: '100.64.1.20' }
      ],
      selectedAddress: '192.168.1.24',
      onSelectedAddressChange: vi.fn(),
      refreshingNetworkInterfaces: false,
      onRefreshNetworkInterfaces,
      loading: false,
      hasQrCode: false,
      onGenerateQr: vi.fn()
    })

    expect(collectText(tree)).toContain('100.64.1.20 (tailscale0)')

    const refreshButton = findByAriaLabel(tree, 'Refresh network interfaces')
    const onClick = refreshButton.props.onClick as () => void
    onClick()

    expect(onRefreshNetworkInterfaces).toHaveBeenCalledTimes(1)
  })
})
