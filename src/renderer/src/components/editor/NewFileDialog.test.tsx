// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NewFileDialog } from './NewFileDialog'
import { createNamedFile, suggestUntitledName } from '@/lib/create-named-file'
import type { NamedFileContext, NamedFileOpenInfo } from '@/lib/create-named-file'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

type Resolver = (name: string | null) => void

function setup(defaultFolder: string, worktreePath = '/repo') {
  const pending: { folder: string; resolve: Resolver }[] = []
  const suggestName = vi.fn(
    (folder: string) =>
      new Promise<string | null>((resolve) => {
        pending.push({ folder, resolve })
      })
  )
  const onCreate = vi.fn().mockResolvedValue(null)
  render(
    <NewFileDialog
      worktreePath={worktreePath}
      defaultFolder={defaultFolder}
      suggestName={suggestName}
      onCreate={onCreate}
      onClose={() => {}}
    />
  )
  const nameInput = (): HTMLElement => screen.getByLabelText('Name')
  const folderInput = (): HTMLElement => screen.getByLabelText('Folder')
  const typeFolder = (value: string): void => {
    fireEvent.change(folderInput(), { target: { value } })
  }
  const settleDebounce = async (): Promise<void> => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })
  }
  const resolveLast = async (name: string | null): Promise<void> => {
    await act(async () => {
      const request = pending.at(-1)
      if (!request) {
        throw new Error('no suggestion lookup is pending')
      }
      request.resolve(name)
    })
  }
  const resolveAt = async (index: number, name: string | null): Promise<void> => {
    await act(async () => {
      pending[index].resolve(name)
    })
  }
  return {
    suggestName,
    onCreate,
    nameInput,
    typeFolder,
    settleDebounce,
    resolveLast,
    resolveAt,
    placeholder: () => nameInput().getAttribute('placeholder') ?? ''
  }
}

function setupWithRealHelpers(worktreePath: string, folder: string, existing: string[]) {
  const createFile = vi.fn().mockResolvedValue(undefined)
  const pathExists = vi.fn(async ({ filePath }: { filePath: string }) =>
    existing.includes(filePath)
  )
  const pickDirectory = vi.fn()
  Object.assign(window, { api: { fs: { createFile, pathExists }, shell: { pickDirectory } } })
  const context: NamedFileContext = {
    target: { kind: 'local' },
    worktreeId: 'wt-1',
    worktreePath
  }
  const created: NamedFileOpenInfo[] = []
  render(
    <NewFileDialog
      worktreePath={worktreePath}
      defaultFolder={folder}
      suggestName={(dir) => suggestUntitledName(context, dir, () => undefined)}
      onCreate={async ({ name, folder: dir }) => {
        created.push(await createNamedFile(context, dir, name, () => undefined))
        return null
      }}
      onClose={() => {}}
    />
  )
  return { createFile, pickDirectory, created }
}

async function flushDebounce(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('NewFileDialog folder handling', () => {
  it.each([
    {
      root: '/repo',
      folder: '/repo/drafts ',
      taken: '/repo/drafts /Untitled1',
      rel: 'drafts /Untitled2'
    },
    {
      root: '/repo',
      folder: '/repo/drafts\t',
      taken: '/repo/drafts\t/Untitled1',
      rel: 'drafts\t/Untitled2'
    },
    {
      root: '/repo',
      folder: '/repo/drafts /',
      taken: '/repo/drafts /Untitled1',
      rel: 'drafts /Untitled2'
    },
    { root: '/repo ', folder: '/repo ', taken: '/repo /Untitled1', rel: 'Untitled2' }
  ])('creates inside the exact folder $folder', async ({ root, folder, taken, rel }) => {
    const view = setupWithRealHelpers(root, folder, [taken])
    await flushDebounce()
    expect(screen.getByLabelText('Name').getAttribute('placeholder')).toBe('Untitled2')

    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await act(async () => {})
    expect(view.created).toHaveLength(1)
    expect(view.created[0]).toMatchObject({
      filePath: `${folder.endsWith('/') ? folder : `${folder}/`}Untitled2`,
      relativePath: rel
    })
    expect(view.createFile).toHaveBeenCalledTimes(1)
  })

  it('uses the exact folder chosen through Browse', async () => {
    const view = setupWithRealHelpers('/repo', '/repo', ['/repo/drafts /Untitled1'])
    view.pickDirectory.mockResolvedValue('/repo/drafts ')
    fireEvent.click(screen.getByRole('button', { name: 'Browse folders' }))
    await act(async () => {})
    await flushDebounce()
    expect(screen.getByLabelText('Name').getAttribute('placeholder')).toBe('Untitled2')

    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await act(async () => {})
    expect(view.created[0]?.relativePath).toBe('drafts /Untitled2')
  })

  it.each([
    ['', 'Folder path cannot be empty'],
    ['   ', 'Folder path cannot be empty'],
    [' /repo/drafts', 'Folder must be inside the current workspace']
  ])('rejects the folder %j without creating', async (folder, message) => {
    const view = setup('/repo')
    view.typeFolder(folder)
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await act(async () => {})
    expect(screen.getByText(message)).toBeDefined()
    expect(view.onCreate).not.toHaveBeenCalled()
  })
})

describe('NewFileDialog suggestion lifecycle', () => {
  it('drops the suggestion as soon as the folder changes', async () => {
    const view = setup('/repo/a')
    await view.settleDebounce()
    await view.resolveLast('Untitled1')
    expect(view.placeholder()).toBe('Untitled1')

    view.typeFolder('/repo/b')
    expect(view.placeholder()).toBe('')
  })

  it('does not revive an old suggestion when returning to a folder whose lookup is null', async () => {
    const view = setup('/repo/a')
    await view.settleDebounce()
    await view.resolveLast('Untitled1')

    view.typeFolder('/repo/b')
    view.typeFolder('/repo/a')
    expect(view.placeholder()).toBe('')
    await view.settleDebounce()
    await view.resolveLast(null)
    expect(view.placeholder()).toBe('')
  })

  it('shows only the fresh suggestion after returning to a folder', async () => {
    const view = setup('/repo/a')
    await view.settleDebounce()
    await view.resolveLast('Untitled1')

    view.typeFolder('/repo/b')
    view.typeFolder('/repo/a')
    await view.settleDebounce()
    expect(view.placeholder()).toBe('')
    await view.resolveLast('Untitled3')
    expect(view.placeholder()).toBe('Untitled3')
  })

  it('ignores a late result for a folder that is no longer shown', async () => {
    const view = setup('/repo/a')
    await view.settleDebounce()

    view.typeFolder('/repo/b')
    await view.settleDebounce()
    await view.resolveAt(1, 'Untitled2')
    await view.resolveAt(0, 'Untitled9')
    expect(view.placeholder()).toBe('Untitled2')
  })

  it('treats a trailing-space folder as a different folder', async () => {
    const view = setup('/repo/a')
    await view.settleDebounce()
    await view.resolveLast('Untitled1')

    view.typeFolder('/repo/a ')
    expect(view.placeholder()).toBe('')
    await view.settleDebounce()
    await view.resolveLast('Untitled7')
    expect(view.placeholder()).toBe('Untitled7')
  })

  it('clears the suggestion when a refreshed lookup for the same folder returns null', async () => {
    const lookups: ((name: string | null) => void)[] = []
    const first = vi.fn(() => new Promise<string | null>((resolve) => lookups.push(resolve)))
    const props = {
      worktreePath: '/repo',
      defaultFolder: '/repo/a',
      onCreate: vi.fn(),
      onClose: () => {}
    }
    const { rerender } = render(<NewFileDialog {...props} suggestName={first} />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })
    await act(async () => lookups[0]('Untitled1'))
    const input = screen.getByLabelText('Name')
    expect(input.getAttribute('placeholder')).toBe('Untitled1')

    const second = vi.fn(() => new Promise<string | null>((resolve) => lookups.push(resolve)))
    rerender(<NewFileDialog {...props} suggestName={second} />)
    expect(input.getAttribute('placeholder') ?? '').toBe('')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })
    await act(async () => lookups[1](null))
    expect(input.getAttribute('placeholder') ?? '').toBe('')
  })
})
