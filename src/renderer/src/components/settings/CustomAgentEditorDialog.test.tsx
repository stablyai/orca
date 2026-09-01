// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AgentCatalogEntry } from '@/lib/agent-catalog'
import type {
  AgentCatalogMutation,
  AgentCatalogMutationResult
} from '../../../../shared/agent-catalog-snapshot'
import { CustomAgentEditorDialog } from './CustomAgentEditorDialog'
import type { CustomAgentDialogMode } from './CustomAgentEditorDialog'

const mutateMock = vi.hoisted(() =>
  vi.fn<(mutation: AgentCatalogMutation) => Promise<AgentCatalogMutationResult>>()
)

vi.mock('@/lib/agent-catalog-authoring', () => ({
  mutateAgentCatalog: (mutation: AgentCatalogMutation) => mutateMock(mutation)
}))

const CODEX_ENTRY: AgentCatalogEntry = {
  id: 'codex',
  label: 'Codex',
  cmd: 'codex',
  homepageUrl: 'https://example.test/codex'
}

const OK_RESULT: AgentCatalogMutationResult = {
  ok: true,
  revision: 9,
  // The dialog only reads `revision` on success.
  snapshot: {} as never
}

function renderDialog(
  overrides: {
    mode?: CustomAgentDialogMode
    onSaved?: (revision: number) => void
    onOpenChange?: (open: boolean) => void
  } = {}
) {
  const onSaved = overrides.onSaved ?? vi.fn()
  const onOpenChange = overrides.onOpenChange ?? vi.fn()
  render(
    <CustomAgentEditorDialog
      open
      mode={overrides.mode ?? { kind: 'new' }}
      baseAgentOptions={[CODEX_ENTRY]}
      onSaved={onSaved}
      onOpenChange={onOpenChange}
    />
  )
  return { onSaved, onOpenChange }
}

function typeInto(element: HTMLElement, value: string): void {
  fireEvent.change(element, { target: { value } })
}

beforeEach(() => {
  mutateMock.mockReset()
  mutateMock.mockResolvedValue(OK_RESULT)
})

afterEach(() => {
  cleanup()
})

describe('CustomAgentEditorDialog — create', () => {
  it('submits a create mutation with the canonical draft and closes on success', async () => {
    const { onSaved, onOpenChange } = renderDialog()

    typeInto(screen.getByLabelText('Name'), 'Fast Codex')
    typeInto(screen.getByLabelText('Arguments'), '--model x')
    typeInto(screen.getByLabelText('Variable name'), 'API_TOKEN')
    typeInto(screen.getByLabelText('Variable value'), 'secret')

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(mutateMock).toHaveBeenCalledTimes(1))
    expect(mutateMock).toHaveBeenCalledWith({
      kind: 'create',
      baseAgent: 'codex',
      draft: {
        label: 'Fast Codex',
        commandOverride: null,
        args: '--model x',
        env: { API_TOKEN: 'secret' },
        syncEnv: false
      }
    })
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(9))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('blocks submit and shows a reserved-name error for a built-in canonical name', async () => {
    renderDialog()
    typeInto(screen.getByLabelText('Name'), 'Claude')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await screen.findByRole('alert')
    expect(screen.getByRole('alert').textContent).toContain('Claude')
    expect(mutateMock).not.toHaveBeenCalled()
  })

  it('previews multiline arguments as tokens and flags a quoted line break', () => {
    renderDialog()
    const args = screen.getByLabelText('Arguments')

    typeInto(args, '--model x\n--safe')
    expect(screen.getByText('3 arguments')).toBeTruthy()

    typeInto(args, '"a\nb"')
    expect(screen.getByText(/multiple lines/i)).toBeTruthy()
  })

  it('reveals a masked environment value on toggle', () => {
    renderDialog()
    const value = screen.getByLabelText('Variable value') as HTMLInputElement
    expect(value.type).toBe('password')
    fireEvent.click(screen.getByRole('button', { name: 'Reveal value' }))
    expect((screen.getByLabelText('Variable value') as HTMLInputElement).type).toBe('text')
  })
})

describe('CustomAgentEditorDialog — duplicate', () => {
  it('submits a name-only duplicate mutation and hides config fields', async () => {
    renderDialog({ mode: { kind: 'duplicate', sourceAgent: 'codex' } })

    expect(screen.queryByLabelText('Arguments')).toBeNull()
    expect(screen.queryByLabelText('Variable name')).toBeNull()

    typeInto(screen.getByLabelText('Name'), 'Codex Copy')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(mutateMock).toHaveBeenCalledTimes(1))
    expect(mutateMock).toHaveBeenCalledWith({
      kind: 'duplicate',
      sourceAgent: 'codex',
      label: 'Codex Copy'
    })
  })
})

describe('CustomAgentEditorDialog — edit', () => {
  const EDIT_ID = 'custom-agent:codex:abc' as const

  beforeEach(() => {
    ;(window as unknown as { api: unknown }).api = {
      settings: {
        agentCatalog: {
          getLocal: vi.fn().mockResolvedValue({ revision: 7 }),
          getLocalDraft: vi.fn().mockResolvedValue({
            status: 'ready',
            revision: 7,
            draft: {
              label: 'Seeded',
              commandOverride: '/bin/x',
              args: '--a',
              env: { K: 'V' },
              syncEnv: true
            }
          })
        }
      }
    }
  })

  it('seeds the draft from getLocalDraft and submits an update-custom mutation', async () => {
    renderDialog({ mode: { kind: 'edit', id: EDIT_ID } })

    const name = (await screen.findByLabelText('Name')) as HTMLInputElement
    await waitFor(() => expect(name.value).toBe('Seeded'))

    typeInto(screen.getByLabelText('Arguments'), '--a --b')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(mutateMock).toHaveBeenCalledTimes(1))
    expect(mutateMock).toHaveBeenCalledWith({
      kind: 'update-custom',
      id: EDIT_ID,
      changes: {
        label: 'Seeded',
        commandOverride: '/bin/x',
        args: '--a --b',
        env: { K: 'V' },
        syncEnv: true
      }
    })
  })
})

describe('CustomAgentEditorDialog — repair', () => {
  const REPAIR_ID = 'custom-agent:codex:def' as const

  beforeEach(() => {
    ;(window as unknown as { api: unknown }).api = {
      settings: {
        agentCatalog: {
          getLocal: vi.fn().mockResolvedValue({ revision: 4 }),
          getLocalDraft: vi.fn().mockResolvedValue({
            status: 'ready',
            revision: 4,
            draft: { label: 'Broken', commandOverride: null, args: '--x', env: {}, syncEnv: false }
          })
        }
      }
    }
  })

  it('repair-edit seeds by token and submits update-custom in place', async () => {
    renderDialog({
      mode: { kind: 'repair-edit', id: REPAIR_ID, repairToken: 'tok', baseAgent: 'codex' }
    })

    const name = (await screen.findByLabelText('Name')) as HTMLInputElement
    await waitFor(() => expect(name.value).toBe('Broken'))
    // The base harness stays read-only when repairing a canonical id in place.
    expect(screen.getByLabelText('Base harness (read-only)')).toBeTruthy()

    typeInto(screen.getByLabelText('Arguments'), '--fixed')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(mutateMock).toHaveBeenCalledTimes(1))
    expect(mutateMock).toHaveBeenCalledWith({
      kind: 'update-custom',
      id: REPAIR_ID,
      changes: { label: 'Broken', commandOverride: null, args: '--fixed', env: {}, syncEnv: false }
    })
  })

  it('repair-replace authors a fresh agent and submits repair-corrupt/replace', async () => {
    renderDialog({ mode: { kind: 'repair-replace', repairToken: 'tok' } })

    expect(screen.getByText('Replace corrupt agent')).toBeTruthy()
    // A replacement chooses its own base, so the picker is editable, not read-only.
    expect(screen.queryByLabelText('Base harness (read-only)')).toBeNull()

    typeInto(screen.getByLabelText('Name'), 'Replacement')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(mutateMock).toHaveBeenCalledTimes(1))
    expect(mutateMock).toHaveBeenCalledWith({
      kind: 'repair-corrupt',
      repairToken: 'tok',
      action: {
        kind: 'replace',
        baseAgent: 'codex',
        draft: { label: 'Replacement', commandOverride: null, args: '', env: {}, syncEnv: false }
      }
    })
  })
})

describe('CustomAgentEditorDialog — revision conflict', () => {
  it('preserves the draft, shows a banner, and does not close on conflict', async () => {
    mutateMock.mockResolvedValue({
      ok: false,
      code: 'catalog_revision_conflict',
      revision: 3
    } as AgentCatalogMutationResult)
    const { onOpenChange } = renderDialog()

    typeInto(screen.getByLabelText('Name'), 'Draft Name')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await screen.findByRole('alert')
    expect(screen.getByRole('alert').textContent?.toLowerCase()).toContain('changed')
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Draft Name')
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })
})
