// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type {
  AvatarGenerationApi,
  AvatarImageAgentStatus
} from '../../../../shared/avatar-generation/avatar-generation-contract'
import { GenerateFaceLine, GenerateFaceTile, useGenerateFace } from './AvatarGenerateFace'
import type { GeneratedAvatar } from './use-avatar-generation'

// The real crop draws on a canvas, which happy-dom lacks.
vi.mock('./bot-avatar-intake', () => ({ avatarPngFromBlob: async () => 'CROPPED' }))

function Face({ onResult }: { onResult: (made: GeneratedAvatar) => void }): React.JSX.Element {
  const face = useGenerateFace(onResult)
  return (
    <TooltipProvider>
      <GenerateFaceTile face={face} />
      <GenerateFaceLine face={face}>
        <span>upload line</span>
      </GenerateFaceLine>
    </TooltipProvider>
  )
}

function stubAgents(
  agents: AvatarImageAgentStatus[],
  generate: AvatarGenerationApi['generate']
): ReturnType<typeof vi.fn> {
  const spy = vi.fn(generate)
  Reflect.set(window, 'api', {
    avatarGeneration: {
      capability: async () => ({ agents }),
      generate: spy,
      cancel: async () => {}
    }
  })
  return spy
}

const CODEX: AvatarImageAgentStatus = { agent: 'codex', status: 'ready' }
const GROK: AvatarImageAgentStatus = { agent: 'grok', status: 'ready' }
const IMAGE = { mimeType: 'image/png', base64: 'AAAA' }

async function describeAndEnter(text: string): Promise<HTMLTextAreaElement> {
  const box = await screen.findByRole<HTMLTextAreaElement>('textbox', {
    name: 'Picture description'
  })
  fireEvent.change(box, { target: { value: text } })
  fireEvent.keyDown(box, { key: 'Enter' })
  return box
}

describe('Generate face', () => {
  beforeEach(() => {
    Reflect.deleteProperty(window, 'api')
  })
  afterEach(cleanup)

  it('generates on Enter and shows the picture with its description under it', async () => {
    const generate = stubAgents([CODEX], async () => ({ ok: true, agent: 'codex', image: IMAGE }))
    const onResult = vi.fn()
    render(<Face onResult={onResult} />)
    await describeAndEnter('a fox astronaut')
    await screen.findByRole('button', { name: 'Edit description' })
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'a fox astronaut', agent: 'codex' })
    )
    expect(onResult).toHaveBeenCalledWith({ png: 'CROPPED', description: 'a fox astronaut' })
    expect(screen.getByText('a fox astronaut')).toBeTruthy()
  })

  it('reopens the description selected from the picture, and Esc goes back to it', async () => {
    stubAgents([CODEX], async () => ({ ok: true, agent: 'codex', image: IMAGE }))
    render(<Face onResult={() => {}} />)
    await describeAndEnter('a fox astronaut')
    fireEvent.click(await screen.findByRole('button', { name: 'Edit description' }))
    const box = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Picture description' })
    await waitFor(() => expect(box.selectionEnd - box.selectionStart).toBe(15))
    fireEvent.keyDown(box, { key: 'Escape' })
    expect(screen.getByRole('button', { name: 'Edit description' })).toBeTruthy()
  })

  it('shows a usage limit under the face and keeps the description', async () => {
    stubAgents([CODEX], async () => ({ ok: false, error: 'usage-limit', agent: 'codex' }))
    render(<Face onResult={() => {}} />)
    const box = await describeAndEnter('a fox astronaut')
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Codex hit its usage limit. Try again later.'
    )
    expect(box.value).toBe('a fox astronaut')
  })

  it('offers the agent menu only when two agents can make pictures', async () => {
    const generate = stubAgents([CODEX], async () => ({ ok: false, error: 'failed' }))
    const { unmount } = render(<Face onResult={() => {}} />)
    // A run starts only once the agents are known.
    await describeAndEnter('a fox astronaut')
    await waitFor(() => expect(generate).toHaveBeenCalled())
    expect(screen.queryByRole('button', { name: 'Generate with Codex' })).toBeNull()
    unmount()
    stubAgents([CODEX, GROK], async () => ({ ok: false, error: 'failed' }))
    render(<Face onResult={() => {}} />)
    expect(await screen.findByRole('button', { name: 'Generate with Codex' })).toBeTruthy()
  })
})
