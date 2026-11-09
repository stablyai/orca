// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SkillSharedLinksView } from './SkillSharedLinksView'
import { useOwnedSkillShares } from './use-owned-skill-shares'

vi.mock('sonner', () => ({ toast: { success: vi.fn() } }))

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'api')
})

function SharedLinks(): React.JSX.Element {
  return (
    <TooltipProvider>
      <SkillSharedLinksView query="" shares={useOwnedSkillShares()} />
    </TooltipProvider>
  )
}

it('keeps the row disabled until Stop all has stopped every link', async () => {
  const shares = ['canonical', 'older1', 'older2'].map((id, index) => ({
    id,
    packageId: 'pkg',
    name: 'skill',
    description: '',
    url: `https://share.onorca.dev/skills/share/${id}`,
    createdAt: '2026-11-08T00:00:00.000Z',
    canonical: index === 0,
    pinnedVersionId: 'v1'
  }))
  const live = new Set(['canonical', 'older1', 'older2'])
  let releaseOlder1!: () => void
  const older1Held = new Promise<void>((resolve) => {
    releaseOlder1 = resolve
  })
  const revokeShare = vi.fn(async (id: string) => {
    if (id === 'older1') {
      await older1Held
    }
    if (!live.delete(id)) {
      throw new Error('skill_share_not_found')
    }
    return { status: 'ok' }
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      skills: {
        listOwnedShares: vi.fn().mockResolvedValue({ status: 'ok', value: shares }),
        getPackage: vi.fn().mockResolvedValue({ status: 'unconfigured', message: '' }),
        revokeShare
      }
    }
  })
  render(<SharedLinks />)

  fireEvent.click(await screen.findByText('+2 older links'))
  fireEvent.click(await screen.findByRole('button', { name: 'Stop all links' }))
  fireEvent.click(screen.getByRole('button', { name: 'Confirm stop all' }))
  await waitFor(() => expect(revokeShare).toHaveBeenCalledTimes(2))

  // A stop enabled mid-sequence could race the remaining links and leave one live.
  for (const button of screen.getAllByRole('button', { name: 'Stop sharing' })) {
    expect(button).toHaveProperty('disabled', true)
  }
  await act(async () => releaseOlder1())
  await waitFor(() => expect([...live]).toEqual([]))
})

it('holds every row while one stop runs so two stops cannot race', async () => {
  const shares = ['alpha', 'beta'].map((id) => ({
    id,
    packageId: `pkg_${id}`,
    name: id,
    description: '',
    url: `https://share.onorca.dev/skills/share/${id}`,
    createdAt: '2026-11-08T00:00:00.000Z',
    canonical: true,
    pinnedVersionId: 'v1'
  }))
  let releaseAlpha!: () => void
  const alphaHeld = new Promise<void>((resolve) => {
    releaseAlpha = resolve
  })
  const revokeShare = vi.fn(async (id: string) => {
    if (id === 'alpha') {
      await alphaHeld
    }
    return { status: 'ok' }
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      skills: {
        listOwnedShares: vi.fn().mockResolvedValue({ status: 'ok', value: shares }),
        revokeShare
      }
    }
  })
  render(<SharedLinks />)

  const [alphaStop] = await screen.findAllByRole('button', { name: 'Stop sharing' })
  fireEvent.click(alphaStop!)
  fireEvent.click(screen.getByRole('button', { name: 'Confirm stop' }))
  await waitFor(() => expect(revokeShare).toHaveBeenCalledWith('alpha'))

  for (const button of screen.getAllByRole('button', { name: 'Stop sharing' })) {
    expect(button).toHaveProperty('disabled', true)
  }
  await act(async () => releaseAlpha())
  await waitFor(() =>
    expect(screen.getAllByRole('button', { name: 'Stop sharing' })).toHaveLength(1)
  )
  expect(screen.getByRole('button', { name: 'Stop sharing' })).toHaveProperty('disabled', false)
})
