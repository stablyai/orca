// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RepoCommandKind } from '../../../../shared/repo-command-kind'

const readRuntimeIssueCommand = vi.fn()
const writeRuntimeIssueCommand = vi.fn()

vi.mock('@/runtime/runtime-hooks-client', () => ({
  readRuntimeIssueCommand,
  writeRuntimeIssueCommand
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

const { useRepositoryIssueCommand } = await import('./use-repository-issue-command')
const { RepositoryIssueCommandSetting } = await import('./RepositoryIssueCommandSetting')

const HOOK_RUNTIME_SETTINGS = { activeRuntimeEnvironmentId: null }

function Probe({ kind }: { kind: RepoCommandKind }): React.JSX.Element {
  const command = useRepositoryIssueCommand({
    hookRuntimeSettings: HOOK_RUNTIME_SETTINGS,
    repoId: 'repo-1',
    repoHostIdentity: 'local',
    selectedHostId: 'local',
    kind
  })
  return <RepositoryIssueCommandSetting {...command} kind={kind} />
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.clearAllMocks()
  readRuntimeIssueCommand.mockImplementation(
    async (_settings: unknown, _repoId: string, _hostId: unknown, kind: RepoCommandKind) => ({
      status: 'ok',
      localContent: kind === 'review' ? 'Review it' : 'Fix it',
      sharedContent: null,
      effectiveContent: null,
      localFilePath: '',
      source: 'local'
    })
  )
  writeRuntimeIssueCommand.mockResolvedValue(undefined)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  document.body.innerHTML = ''
})

// Why: React tracks the value setter, so a plain assignment is swallowed as a no-op change.
function setTextareaValue(textarea: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  setter?.call(textarea, value)
}

async function render(kind: RepoCommandKind): Promise<HTMLTextAreaElement> {
  await act(async () => {
    root.render(<Probe kind={kind} />)
  })
  const textarea = container.querySelector('textarea')
  if (!textarea) {
    throw new Error('no textarea rendered')
  }
  return textarea
}

describe('RepositoryIssueCommandSetting', () => {
  it('reads and writes the review kind under its own label', async () => {
    const textarea = await render('review')
    expect(textarea.getAttribute('aria-label')).toBe('Custom Review Command')
    expect(textarea.value).toBe('Review it')
    expect(readRuntimeIssueCommand).toHaveBeenCalledWith(
      expect.anything(),
      'repo-1',
      'local',
      'review'
    )

    await act(async () => {
      setTextareaValue(textarea, 'Review {{artifact_url}} carefully')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      textarea.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })

    expect(writeRuntimeIssueCommand).toHaveBeenCalledWith(
      expect.anything(),
      'repo-1',
      'Review {{artifact_url}} carefully',
      'local',
      'review'
    )
    expect(writeRuntimeIssueCommand).not.toHaveBeenCalledWith(
      expect.anything(),
      'repo-1',
      expect.anything(),
      'local',
      'issue'
    )
  })

  it('still reads the issue kind for the issue field', async () => {
    const textarea = await render('issue')
    expect(textarea.getAttribute('aria-label')).toBe('Custom GitHub Issue Command')
    expect(textarea.value).toBe('Fix it')
    expect(readRuntimeIssueCommand).toHaveBeenCalledWith(
      expect.anything(),
      'repo-1',
      'local',
      'issue'
    )
  })
})
