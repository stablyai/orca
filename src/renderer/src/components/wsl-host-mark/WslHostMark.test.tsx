// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { selectWslHostDistro, WslHostMark } from './WslHostMark'

afterEach(cleanup)

const wslEnvironment = {
  id: 'env-wsl',
  orcadDeployment: {
    kind: 'wsl' as const,
    distro: 'orca-demo',
    localPort: 42000,
    remotePort: 6768
  }
}
const sshEnvironment = {
  id: 'env-ssh',
  orcadDeployment: {
    sshTargetId: 'box',
    sshTargetGeneration: 1,
    localPort: 41000,
    remotePort: 6768
  }
}

describe('selectWslHostDistro', () => {
  it('names the distro only for a WSL host runtime', () => {
    const s = { runtimeEnvironments: [wslEnvironment, sshEnvironment] }
    expect(selectWslHostDistro(s, 'runtime:env-wsl')).toBe('orca-demo')
    expect(selectWslHostDistro(s, 'runtime:env-ssh')).toBeNull()
    expect(selectWslHostDistro(s, 'runtime:missing')).toBeNull()
    expect(selectWslHostDistro(s, 'local')).toBeNull()
    expect(selectWslHostDistro(s, 'ssh:box')).toBeNull()
    expect(selectWslHostDistro(s, null)).toBeNull()
  })
})

describe('WslHostMark', () => {
  it('is a penguin named for screen readers, with the full host in its tooltip', async () => {
    const view = render(
      <TooltipProvider delayDuration={0}>
        <WslHostMark distro="orca-demo" />
      </TooltipProvider>
    )
    const mark = view.getByRole('img', {
      name: 'Runs on WSL: orca-demo (Linux)'
    })
    expect(mark.querySelector('svg')).toBeTruthy()
    expect(view.queryByText('orca-demo (WSL)')).toBeNull()
    await act(async () => {
      fireEvent.pointerMove(mark, { pointerType: 'mouse' })
      fireEvent.focus(mark)
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(document.querySelector('[data-slot="tooltip-content"]')?.textContent).toContain(
      'Runs on WSL: orca-demo (Linux)'
    )
  })

  it('leaves the tooltip to the row when asked', () => {
    const view = render(<WslHostMark distro="orca-demo" withTooltip={false} />)
    expect(view.getByRole('img', { name: 'Runs on WSL: orca-demo (Linux)' })).toBeTruthy()
    expect(view.container.querySelector('[data-slot="tooltip-trigger"]')).toBeNull()
  })
})
