// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SshTargetCard } from './SshTargetCard'
import { TooltipProvider } from '../ui/tooltip'
import type { SshConnectionState, SshTarget } from '../../../../shared/ssh-types'

afterEach(() => {
  document.body.innerHTML = ''
})

const target: SshTarget = {
  id: 'target-1',
  label: 'build-01',
  host: 'build-01.internal',
  port: 22,
  username: 'deploy'
}

/** The real thing a host key mismatch produces: the remedy is the last clause. */
const HOST_KEY_ERROR =
  'Host key verification failed for build-01.internal. The key does not match the entry in your known_hosts file. ssh and git will refuse this host too. Run: ssh-keygen -R build-01.internal'

type CardOverrides = {
  target?: SshTarget
  onOpenServiceLink?: (url: string) => void
}

async function renderCard(
  state: SshConnectionState | undefined,
  overrides: CardOverrides = {}
): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    createRoot(container).render(
      <TooltipProvider>
        <SshTargetCard
          target={overrides.target ?? target}
          state={state}
          testing={false}
          onConnect={vi.fn()}
          onDisconnect={vi.fn()}
          onTerminateSessions={vi.fn()}
          onResetRelay={vi.fn()}
          onTest={vi.fn()}
          onEdit={vi.fn()}
          onRemove={vi.fn()}
          onOpenServiceLink={overrides.onOpenServiceLink ?? vi.fn()}
        />
      </TooltipProvider>
    )
  })
  return container
}

function serviceLinksButton(container: HTMLElement, label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll('button')].find((candidate) =>
    candidate.textContent?.includes(label)
  )
  if (!match) {
    throw new Error(`missing ${label} service link button`)
  }
  return match
}

const errorState = (error: string): SshConnectionState => ({
  targetId: 'target-1',
  status: 'error',
  error,
  reconnectAttempt: 0,
  supportsFolderDownload: false
})

describe('the connection error on an SSH target card', () => {
  it('shows the whole message, remedy included', async () => {
    const container = await renderCard(errorState(HOST_KEY_ERROR))

    expect(container.textContent).toContain('ssh-keygen -R build-01.internal')
  })

  // This is the regression that made the careful wording pointless: `truncate` clamps to one line
  // with an ellipsis and there is no title attribute, so the remedy was unreachable even on hover.
  it('does not clamp it to a single line', async () => {
    const container = await renderCard(errorState(HOST_KEY_ERROR))
    const paragraph = [...container.querySelectorAll('p')].find((node) =>
      node.textContent?.includes('ssh-keygen')
    )

    expect(paragraph).toBeDefined()
    expect(paragraph?.className).not.toContain('truncate')
    // A long hostname has no break opportunity, so wrapping alone would still overflow the column.
    expect(paragraph?.className).toContain('[overflow-wrap:anywhere]')
  })

  it('renders nothing when there is no error', async () => {
    const container = await renderCard(undefined)

    expect(container.textContent).not.toContain('Host key verification failed')
  })
})

describe('the service links on an SSH target card', () => {
  const linkUrl = 'https://build-box.example.ts.net'
  const withServiceLinks: SshTarget = {
    ...target,
    serviceLinks: [{ label: 'Grafana', url: linkUrl }]
  }

  it('renders a ghost button per link', async () => {
    const container = await renderCard(undefined, { target: withServiceLinks })
    const button = serviceLinksButton(container, 'Grafana')

    expect(button.getAttribute('data-variant')).toBe('ghost')
    expect(container.textContent).toContain('Grafana')
  })

  it('opens the link URL on click', async () => {
    const onOpenServiceLink = vi.fn()
    const container = await renderCard(undefined, { target: withServiceLinks, onOpenServiceLink })

    await act(async () => {
      serviceLinksButton(container, 'Grafana').dispatchEvent(
        new MouseEvent('click', { bubbles: true })
      )
    })

    expect(onOpenServiceLink).toHaveBeenCalledWith(linkUrl)
  })

  it('renders no link buttons when the target has none', async () => {
    const container = await renderCard(undefined)

    expect(container.textContent).not.toContain('Grafana')
  })
})
