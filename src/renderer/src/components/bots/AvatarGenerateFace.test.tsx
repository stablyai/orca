// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { TooltipProvider } from '@/components/ui/tooltip'
import type {
  AvatarGenerationApi,
  AvatarImageAgentStatus
} from '../../../../shared/avatar-generation/avatar-generation-contract'
import { GenerateField, GenerateFaceTile, useGenerateFace } from './AvatarGenerateFace'
import type { GeneratedAvatar } from './use-avatar-generation'

// The real crop draws on a canvas, which happy-dom lacks.
vi.mock('./bot-avatar-intake', () => ({ avatarPngFromBlob: async () => 'CROPPED' }))

function Face({ onResult }: { onResult: (made: GeneratedAvatar) => void }): React.JSX.Element {
  const face = useGenerateFace(onResult)
  return (
    <TooltipProvider>
      <GenerateFaceTile face={face} />
      <GenerateField face={face} />
    </TooltipProvider>
  )
}

function stubAgents(
  agents: AvatarImageAgentStatus[],
  generate: AvatarGenerationApi['generate'],
  cancel: AvatarGenerationApi['cancel'] = async () => {}
): ReturnType<typeof vi.fn> {
  const spy = vi.fn(generate)
  Reflect.set(window, 'api', {
    avatarGeneration: {
      capability: async () => ({ agents }),
      generate: spy,
      cancel
    }
  })
  return spy
}

const CODEX: AvatarImageAgentStatus = { agent: 'codex', status: 'ready' }
const GROK: AvatarImageAgentStatus = { agent: 'grok', status: 'ready' }
const IMAGE = { mimeType: 'image/png', base64: 'AAAA' }

/** Whether the field is folded away (the description line shows in its place). */
function folded(box: HTMLElement): boolean {
  return box.closest('[aria-hidden="true"]') !== null
}

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

  it('generates on Enter and folds the field to the description under the picture', async () => {
    const generate = stubAgents([CODEX], async () => ({ ok: true, agent: 'codex', image: IMAGE }))
    const onResult = vi.fn()
    render(<Face onResult={onResult} />)
    const box = await describeAndEnter('a fox astronaut')
    expect(folded(box)).toBe(false)
    await screen.findByRole('button', { name: 'Edit description' })
    expect(folded(box)).toBe(true)
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'a fox astronaut', agent: 'codex' })
    )
    expect(onResult).toHaveBeenCalledWith({ png: 'CROPPED', description: 'a fox astronaut' })
    expect(screen.getByRole('button', { name: 'a fox astronaut' })).toBeTruthy()
  })

  it('reopens the field with the description selected, and Esc folds it without closing the dialog', async () => {
    stubAgents([CODEX], async () => ({ ok: true, agent: 'codex', image: IMAGE }))
    const onOpenChange = vi.fn()
    render(
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogTitle>New</DialogTitle>
          <Face onResult={() => {}} />
        </DialogContent>
      </Dialog>
    )
    const box = await describeAndEnter('a fox astronaut')
    fireEvent.click(await screen.findByRole('button', { name: 'Edit description' }))
    expect(folded(box)).toBe(false)
    await waitFor(() => expect(box.selectionEnd - box.selectionStart).toBe(15))
    fireEvent.keyDown(box, { key: 'Escape' })
    expect(folded(box)).toBe(true)
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('reopens the field from the description line too', async () => {
    stubAgents([CODEX], async () => ({ ok: true, agent: 'codex', image: IMAGE }))
    render(<Face onResult={() => {}} />)
    const box = await describeAndEnter('a fox astronaut')
    fireEvent.click(await screen.findByRole('button', { name: 'a fox astronaut' }))
    expect(folded(box)).toBe(false)
  })

  it('cancels a run from the face, or with Esc in the field', async () => {
    const cancel = vi.fn(async () => {})
    stubAgents([CODEX], () => new Promise(() => {}), cancel)
    render(<Face onResult={() => {}} />)
    const box = await describeAndEnter('a fox astronaut')
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel generating' }))
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(box.readOnly).toBe(false)
    fireEvent.keyDown(box, { key: 'Enter' })
    await screen.findByRole('button', { name: 'Cancel generating' })
    fireEvent.keyDown(box, { key: 'Escape' })
    expect(cancel).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('button', { name: 'Cancel generating' })).toBeNull()
  })

  it('shows a usage limit under the field and keeps the description', async () => {
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
