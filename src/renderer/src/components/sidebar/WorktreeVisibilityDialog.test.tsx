// @vitest-environment happy-dom
import {
  SCRATCH_PATH,
  mocks,
  makeRepo,
  makeWorktree,
  makeDetected,
  root,
  renderDialog,
  deferred,
  buttonWithText,
  sourceSegment,
  sourceSwitch,
  sourceRow,
  inheritEverythingFromGlobal,
  click,
  setInputValue
} from './worktree-visibility-dialog-test-fixtures'
import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
describe('WorktreeVisibilityDialog', () => {
  it('links directly to the global visibility defaults', async () => {
    await renderDialog()

    const manageGlobalSettings = buttonWithText('Manage in Global Settings')
    expect(manageGlobalSettings.querySelector('.lucide-settings')).not.toBeNull()
    await click(manageGlobalSettings)

    expect(mocks.state.closeModal).toHaveBeenCalledOnce()
    expect(mocks.state.openSettingsTarget).toHaveBeenCalledWith({
      pane: 'general',
      repoId: null,
      sectionId: 'general-global-worktree-visibility'
    })
    expect(mocks.state.openSettingsPage).toHaveBeenCalledOnce()
  })

  it('lists a hidden agent worktree with a repo-relative path', async () => {
    await renderDialog()

    expect(document.body.textContent).toContain('Hidden worktrees (1)')
    expect(document.body.textContent).toContain('Show one without enabling its source.')
    expect(document.body.textContent).toContain('scratch-1')
    expect(document.body.textContent).toContain('.claude/worktrees/scratch-1')
    expect(document.body.textContent).not.toContain('/repo/.claude')
    expect(
      document.querySelector('button[aria-label="Which worktrees are hidden by default?"]')
    ).not.toBeNull()
  })

  it('bounds rendered rows for repositories with many hidden worktrees', async () => {
    const worktrees = Array.from({ length: 500 }, (_, index) =>
      makeWorktree({
        id: `hidden-${index}`,
        path: `/repo/.claude/worktrees/scratch-${index}`,
        displayName: `scratch-${index}`
      })
    )
    mocks.state.detectedWorktreesByRepo = { 'repo-1': makeDetected(worktrees) }

    await renderDialog()

    expect(document.body.textContent).toContain('Hidden worktrees (500)')
    expect(document.querySelectorAll('ul > li').length).toBeLessThan(20)
    const search = document.querySelector<HTMLInputElement>(
      'input[aria-label="Search hidden worktrees"]'
    )
    expect(search).not.toBeNull()
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        search,
        'scratch-499'
      )
      search!.dispatchEvent(new Event('input', { bubbles: true }))
      search!.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(document.body.textContent).toContain('scratch-499')
    expect(document.body.textContent).not.toContain('scratch-0')
  })

  it('gives each hidden worktree action a distinct accessible name', async () => {
    mocks.state.detectedWorktreesByRepo = {
      'repo-1': makeDetected([
        makeWorktree({ displayName: 'scratch-a', path: '/repo/.claude/worktrees/scratch-a' }),
        makeWorktree({ displayName: 'scratch-b', path: '/repo/.claude/worktrees/scratch-b' })
      ])
    }

    await renderDialog()

    expect(
      document.querySelector('button[aria-label="Show scratch-a at .claude/worktrees/scratch-a"]')
    ).not.toBeNull()
    expect(
      document.querySelector('button[aria-label="Show scratch-b at .claude/worktrees/scratch-b"]')
    ).not.toBeNull()
  })

  it('recovers a hidden worktree per path through the existing import exception', async () => {
    await renderDialog()

    await click(buttonWithText('Show'))

    expect(mocks.state.updateRepo).toHaveBeenCalledWith(
      'repo-1',
      {
        importedExternalWorktreePaths: [SCRATCH_PATH],
        externalWorktreeInboxBaselinePaths: [SCRATCH_PATH]
      },
      { hostId: 'local' }
    )
    expect(mocks.state.fetchWorktrees).toHaveBeenCalledWith('repo-1', {
      requireAuthoritative: true,
      executionHostId: 'local'
    })
    expect(mocks.state.closeModal).not.toHaveBeenCalled()
  })

  it('omits the hidden list when nothing is recoverable', async () => {
    mocks.state.detectedWorktreesByRepo = { 'repo-1': makeDetected([]) }
    await renderDialog()

    expect(document.body.textContent).toContain('Hidden worktrees (0)')
    expect(document.body.textContent).toContain('No non-Orca worktrees found')
  })

  it('says it is checking instead of claiming nothing is hidden on a fallback snapshot', async () => {
    mocks.state.detectedWorktreesByRepo = {
      'repo-1': makeDetected([makeWorktree()], { authoritative: false, source: 'session-fallback' })
    }
    mocks.state.fetchWorktrees.mockImplementation(() => new Promise(() => {}))
    await renderDialog()

    expect(document.body.textContent).toContain('Checking…')
    expect(document.body.textContent).not.toContain('Hidden worktrees')
    expect(mocks.state.fetchWorktrees).toHaveBeenCalledWith('repo-1', {
      requireAuthoritative: true,
      executionHostId: 'local'
    })
  })

  it('offers a retry instead of a dead end when the list cannot be read', async () => {
    mocks.state.detectedWorktreesByRepo = {
      'repo-1': makeDetected([makeWorktree()], { authoritative: false, source: 'session-fallback' })
    }
    mocks.state.fetchWorktrees.mockResolvedValue(false)
    await renderDialog()

    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Could not list this repo's worktrees."
    )

    mocks.state.fetchWorktrees.mockImplementation(async () => {
      mocks.state.detectedWorktreesByRepo = { 'repo-1': makeDetected() }
      return true
    })
    await click(buttonWithText('Try again'))

    expect(document.querySelector('[role="alert"]')).toBeNull()
    expect(document.body.textContent).toContain('Hidden worktrees')
  })

  it('keeps rows visible but not actionable until the open-time scan settles', async () => {
    // Mid-scan writes must not reuse a pre-write confirmation fetch and falsely report successful recovery.
    mocks.state.fetchWorktrees.mockImplementation(() => new Promise(() => {}))
    await renderDialog()

    expect(document.body.textContent).toContain('scratch-1')
    expect(buttonWithText('Show').disabled).toBe(true)
    expect(document.body.textContent).toContain('Checking…')
  })

  it('locks the repo-wide toggle until the open-time scan settles', async () => {
    // Post-write refresh must not coalesce onto scans started before the visibility write.
    mocks.state.fetchWorktrees.mockImplementation(() => new Promise(() => {}))
    await renderDialog()

    expect(sourceSwitch().disabled).toBe(true)
  })

  it('reports a failed refresh even while an older trusted snapshot is on screen', async () => {
    // Warm snapshots need failure indicators when the host has since become unreachable.
    mocks.state.fetchWorktrees.mockResolvedValue(false)
    await renderDialog()

    expect(document.body.textContent).toContain('scratch-1')
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Could not list this repo's worktrees."
    )
  })

  it('locks retry while a row import is in flight, so it cannot race the write', async () => {
    // Retry must not start a pre-import scan that absorbs the import’s confirmation refresh.
    mocks.state.fetchWorktrees.mockResolvedValue(false)
    mocks.state.updateRepo.mockImplementation(() => new Promise(() => {}))
    await renderDialog()

    await click(buttonWithText('Show'))

    expect(buttonWithText('Try again').disabled).toBe(true)
  })

  it('locks the repo-wide toggle while a row import is in flight', async () => {
    mocks.state.fetchWorktrees.mockResolvedValue(false)
    mocks.state.updateRepo.mockImplementation(() => new Promise(() => {}))
    await renderDialog()

    await click(buttonWithText('Show'))

    expect(sourceSwitch().disabled).toBe(true)
  })

  it('locks row actions and retry while the repo-wide toggle is in flight', async () => {
    mocks.state.fetchWorktrees.mockResolvedValueOnce(false)
    mocks.state.updateRepo.mockImplementation(() => new Promise(() => {}))
    await renderDialog()

    await click(sourceSwitch())

    expect(buttonWithText('Show').disabled).toBe(true)
    expect(buttonWithText('Try again').disabled).toBe(true)
  })

  it('clears a stale failure once a row import refreshes the list successfully', async () => {
    mocks.state.fetchWorktrees.mockResolvedValueOnce(false)
    await renderDialog()
    expect(document.querySelector('[role="alert"]')).not.toBeNull()

    mocks.state.fetchWorktrees.mockResolvedValue(true)
    await click(buttonWithText('Show'))

    expect(document.querySelector('[role="alert"]')).toBeNull()
  })

  it('does not leak an old repo action failure into a newly opened repo', async () => {
    const update = deferred<boolean>()
    mocks.state.updateRepo.mockReturnValueOnce(update.promise)
    await renderDialog()
    await click(buttonWithText('Show'))

    mocks.state.modalData = { repoId: 'repo-2' }
    mocks.state.repos = [makeRepo({ id: 'repo-2', path: '/repo-2', displayName: 'other' })]
    mocks.state.detectedWorktreesByRepo = { 'repo-2': makeDetected([], { repoId: 'repo-2' }) }
    await renderDialog()

    update.resolve(false)
    await act(async () => update.promise)

    expect(document.querySelector('[role="alert"]')).toBeNull()
  })

  it('keeps a remounted repo locked until its earlier row action settles', async () => {
    const update = deferred<boolean>()
    mocks.state.updateRepo.mockReturnValueOnce(update.promise)
    await renderDialog()
    mocks.state.fetchWorktrees.mockClear()
    await click(buttonWithText('Show'))

    await act(async () => root.render(null))
    await renderDialog()

    expect(document.body.textContent).toContain('Hidden worktrees (1)')
    expect(buttonWithText('Showing…').disabled).toBe(true)
    expect(mocks.state.fetchWorktrees).not.toHaveBeenCalled()

    await act(async () => {
      update.resolve(false)
      await update.promise
      await Promise.resolve()
    })
    expect(buttonWithText('Show').disabled).toBe(false)
  })

  it('keeps a remounted repo locked until its earlier toggle settles', async () => {
    const update = deferred<boolean>()
    mocks.state.updateRepo.mockReturnValueOnce(update.promise)
    await renderDialog()
    mocks.state.fetchWorktrees.mockClear()
    await click(sourceSwitch())

    await act(async () => root.render(null))
    await renderDialog()

    expect(sourceSwitch().disabled).toBe(true)
    expect(buttonWithText('Show').disabled).toBe(true)
    expect(mocks.state.fetchWorktrees).not.toHaveBeenCalled()

    await act(async () => {
      update.resolve(false)
      await update.promise
      await Promise.resolve()
    })
    expect(sourceSwitch().disabled).toBe(false)
  })

  it('does not carry a mutation fence across same-id repos on different hosts', async () => {
    const update = deferred<boolean>()
    const localWorktree = makeWorktree({ hostId: 'local' })
    const remotePath = '/srv/repo/.claude/worktrees/remote-scratch'
    const remoteWorktree = makeWorktree({
      id: `repo-1::${remotePath}`,
      path: remotePath,
      displayName: 'remote-scratch',
      hostId: 'runtime:env-1'
    })
    mocks.state.modalData = { repoId: 'repo-1', hostId: 'local' }
    mocks.state.repos = [
      makeRepo(),
      makeRepo({ path: '/srv/repo', displayName: 'remote', executionHostId: 'runtime:env-1' })
    ]
    mocks.state.detectedWorktreesByRepo = {
      'repo-1': makeDetected([localWorktree, remoteWorktree])
    }
    mocks.state.updateRepo.mockReturnValueOnce(update.promise)
    await renderDialog()
    await click(buttonWithText('Show'))

    await act(async () => root.render(null))
    mocks.state.modalData = { repoId: 'repo-1', hostId: 'runtime:env-1' }
    mocks.state.fetchWorktrees.mockClear()
    await renderDialog()

    expect(document.body.textContent).toContain('remote-scratch')
    expect(document.body.textContent).not.toContain('scratch-1')
    expect(buttonWithText('Show').disabled).toBe(false)
    expect(mocks.state.fetchWorktrees).toHaveBeenCalledWith('repo-1', {
      requireAuthoritative: true,
      executionHostId: 'runtime:env-1'
    })

    await click(buttonWithText('Show'))
    expect(mocks.state.updateRepo).toHaveBeenLastCalledWith(
      'repo-1',
      {
        importedExternalWorktreePaths: [remotePath],
        externalWorktreeInboxBaselinePaths: [SCRATCH_PATH, remotePath]
      },
      { hostId: 'runtime:env-1' }
    )

    await act(async () => {
      update.resolve(false)
      await update.promise
    })
  })

  it('reports a failed persistent visibility update without starting a refresh', async () => {
    mocks.state.updateRepo.mockResolvedValue(false)
    await renderDialog()
    mocks.state.fetchWorktrees.mockClear()

    await click(sourceSwitch())

    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'Could not update worktree visibility. Try again.'
    )
    expect(mocks.state.fetchWorktrees).not.toHaveBeenCalled()
  })

  it('does not report success when an older host strips additive source settings (STA-4092)', async () => {
    mocks.state.updateRepo.mockResolvedValue(true)
    await renderDialog()
    mocks.state.fetchWorktrees.mockClear()

    await click(sourceSwitch())

    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "This host doesn't support source-specific worktree visibility. Update Orca on the host to change this setting."
    )
    expect(document.querySelector('[role="alert"]')?.textContent).not.toContain('Try again')
    expect(mocks.state.fetchWorktrees).not.toHaveBeenCalled()
  })

  it('reports a failed authoritative refresh after updating persistent visibility', async () => {
    await renderDialog()
    mocks.state.fetchWorktrees.mockResolvedValue(false)

    await click(sourceSwitch())

    expect(mocks.state.fetchWorktrees).toHaveBeenLastCalledWith('repo-1', {
      requireAuthoritative: true
    })
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Could not list this repo's worktrees."
    )
  })

  it('toggles built-in sources independently', async () => {
    await renderDialog()

    expect(sourceSwitch('Claude Code').getAttribute('aria-checked')).toBe('false')
    expect(sourceSwitch('GSD').getAttribute('aria-checked')).toBe('false')

    await click(sourceSwitch('Claude Code'))

    expect(mocks.state.updateRepo).toHaveBeenCalledWith('repo-1', {
      worktreeVisibilitySourcePreferences: {
        builtIn: { claude: 'show' }
      }
    })
    expect(mocks.state.closeModal).not.toHaveBeenCalled()
  })

  it('shows when source visibility is inherited from the global default', async () => {
    inheritEverythingFromGlobal()

    await renderDialog()

    expect(sourceRow('Claude Code').textContent).not.toContain('Overriding global setting')
    expect(sourceRow('GSD').textContent).not.toContain('Overriding global setting')
    expect(sourceRow('Other locations').textContent).not.toContain('Overriding global setting')
    expect(sourceSwitch('Claude Code').getAttribute('aria-checked')).toBe('true')
    expect(sourceSwitch('GSD').getAttribute('aria-checked')).toBe('false')
  })

  it('lists what each inheritable source is set to in global settings', async () => {
    inheritEverythingFromGlobal()

    await renderDialog()

    const intro = [...document.querySelectorAll('p')].find(
      (candidate) =>
        candidate.textContent === 'These sources have a global setting you can override here:'
    )
    expect(intro).not.toBeUndefined()
    expect(
      [...(intro?.nextElementSibling?.querySelectorAll('li') ?? [])].map((item) => item.textContent)
    ).toEqual(['Claude CodeShow', 'GSDHide', 'Other locationsHide'])
    expect(buttonWithText('Manage in Global Settings')).not.toBeNull()
  })

  it('names the global value an override is ignoring and reverts on the same control', async () => {
    mocks.state.repos = [
      makeRepo({
        worktreeVisibilitySourcePreferences: {
          builtIn: { claude: 'show', gsd: 'show' }
        }
      })
    ]
    mocks.state.settings = {
      worktreeVisibilityDefaults: {
        external: 'hide',
        sourcePreferences: { builtIn: { claude: 'hide', gsd: 'hide' } }
      }
    }
    await renderDialog()

    expect(sourceRow('Claude Code').textContent).toContain('Overriding global setting: Hide')
    await click(sourceSegment('Claude Code', 'hide'))

    expect(mocks.state.updateRepo).toHaveBeenCalledWith('repo-1', {
      agentWorktreeVisibility: null,
      worktreeVisibilitySourcePreferences: { builtIn: { gsd: 'show' } }
    })
  })

  it('materializes the remaining legacy source override when one source reverts to global', async () => {
    mocks.state.repos = [makeRepo({ agentWorktreeVisibility: 'show' })]
    mocks.state.settings = { worktreeVisibilityDefaults: { external: 'hide' } }
    await renderDialog()

    await click(sourceSegment('Claude Code', 'hide'))

    expect(mocks.state.updateRepo).toHaveBeenCalledWith('repo-1', {
      agentWorktreeVisibility: null,
      worktreeVisibilitySourcePreferences: { builtIn: { gsd: 'show' } }
    })
  })

  it('migrates legacy Always show to both built-in source rows', async () => {
    mocks.state.repos = [makeRepo({ agentWorktreeVisibility: 'show' })]
    // Global must also show so hiding creates an override rather than reverting to inheritance.
    mocks.state.settings = {
      worktreeVisibilityDefaults: {
        external: 'hide',
        sourcePreferences: { builtIn: { claude: 'show', gsd: 'show' } }
      }
    }
    await renderDialog()

    expect(sourceSwitch('Claude Code').getAttribute('aria-checked')).toBe('true')
    expect(sourceSwitch('GSD').getAttribute('aria-checked')).toBe('true')

    await click(sourceSegment('Claude Code', 'hide'))

    expect(mocks.state.updateRepo).toHaveBeenCalledWith('repo-1', {
      worktreeVisibilitySourcePreferences: {
        builtIn: { claude: 'hide', gsd: 'show' }
      }
    })
  })

  it('keeps ordinary non-Orca visibility on its own source row', async () => {
    mocks.state.repos = [makeRepo({ externalWorktreeVisibility: 'show' })]
    // Global must also show so hiding creates an override rather than reverting to inheritance.
    mocks.state.settings = { worktreeVisibilityDefaults: { external: 'show' } }
    await renderDialog()

    expect(sourceSwitch('Other locations').getAttribute('aria-checked')).toBe('true')
    await click(sourceSegment('Other locations', 'hide'))

    expect(mocks.state.updateRepo).toHaveBeenCalledWith('repo-1', {
      externalWorktreeVisibility: 'hide'
    })
  })

  it('adds custom locations disabled by default', async () => {
    await renderDialog()
    const input = document.querySelector<HTMLInputElement>('#custom-worktree-root')
    expect(input).not.toBeNull()
    expect(
      document.querySelector('section[aria-labelledby="worktree-sources-heading"]')?.contains(input)
    ).toBe(true)
    expect(input?.closest('form')?.getAttribute('aria-label')).toBe('Add location')
    expect(input?.closest('form')?.textContent).not.toContain('Add location')
    await setInputValue(input!, '/srv/team-worktrees')
    await click(buttonWithText('Add'))

    expect(mocks.state.updateRepo).toHaveBeenCalledWith(
      'repo-1',
      expect.objectContaining({
        customWorktreeVisibilitySources: [
          expect.objectContaining({ rootPath: '/srv/team-worktrees' })
        ],
        worktreeVisibilitySourcePreferences: expect.objectContaining({
          custom: expect.objectContaining({})
        })
      })
    )
    const update = mocks.state.updateRepo.mock.calls.at(-1)?.[1] as {
      customWorktreeVisibilitySources: { id: string }[]
      worktreeVisibilitySourcePreferences: { custom: Record<string, string> }
    }
    expect(
      update.worktreeVisibilitySourcePreferences.custom[
        update.customWorktreeVisibilitySources[0]!.id
      ]
    ).toBe('hide')
  })

  it('keeps source matching stable while typing in the inline form', async () => {
    mocks.state.repos = [
      makeRepo({
        customWorktreeVisibilitySources: [{ id: 'team', rootPath: '/srv/team-worktrees' }]
      })
    ]
    await renderDialog()
    const normalize = vi.spyOn(String.prototype, 'normalize')

    await setInputValue(
      document.querySelector<HTMLInputElement>('#custom-worktree-root')!,
      '/srv/x'
    )

    expect(normalize).not.toHaveBeenCalled()
    normalize.mockRestore()
  })

  it('distinguishes invalid, duplicate, limit, and save failures when adding a source', async () => {
    const existing = Array.from({ length: 32 }, (_, index) => ({
      id: `source-${index}`,
      rootPath: `/srv/source-${index}`
    }))
    mocks.state.repos = [makeRepo({ customWorktreeVisibilitySources: existing })]
    await renderDialog()
    const input = document.querySelector<HTMLInputElement>('#custom-worktree-root')!
    await setInputValue(input, '/srv/new')
    await click(buttonWithText('Add'))
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'Remove a custom location before adding another.'
    )
    expect(mocks.state.updateRepo).not.toHaveBeenCalled()

    mocks.state.repos = [makeRepo({ customWorktreeVisibilitySources: existing.slice(0, 1) })]
    await act(async () => root.render(null))
    await renderDialog()
    const duplicateInput = document.querySelector<HTMLInputElement>('#custom-worktree-root')!
    await setInputValue(duplicateInput, '/srv/source-0')
    await click(buttonWithText('Add'))
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'This location is already listed.'
    )

    await setInputValue(duplicateInput, 'relative/path')
    await click(buttonWithText('Add'))
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'Enter an absolute path for this host.'
    )

    mocks.state.updateRepo.mockResolvedValue(false)
    await setInputValue(duplicateInput, '/srv/valid')
    await click(buttonWithText('Add'))
    const alerts = [...document.querySelectorAll('[role="alert"]')]
    expect(alerts).toHaveLength(1)
    expect(alerts[0]?.textContent).toContain('Could not update worktree visibility. Try again.')
    expect(alerts[0]?.textContent).not.toContain('Enter an absolute path')
  })

  it('reports only unsupported-host copy when an older host strips an added source', async () => {
    mocks.state.updateRepo.mockResolvedValue(true)
    await renderDialog()
    mocks.state.fetchWorktrees.mockClear()
    const input = document.querySelector<HTMLInputElement>('#custom-worktree-root')!

    await setInputValue(input, '/srv/valid')
    await click(buttonWithText('Add'))

    const alerts = [...document.querySelectorAll('[role="alert"]')]
    expect(alerts).toHaveLength(1)
    expect(alerts[0]?.textContent).toContain(
      "This host doesn't support source-specific worktree visibility."
    )
    expect(alerts[0]?.textContent).not.toContain('Enter an absolute path')
    expect(mocks.state.fetchWorktrees).not.toHaveBeenCalled()
  })

  it('removes custom locations without changing other source preferences', async () => {
    mocks.state.repos = [
      makeRepo({
        customWorktreeVisibilitySources: [{ id: 'team', rootPath: '/srv/team-worktrees' }],
        worktreeVisibilitySourcePreferences: { custom: { team: 'hide' } }
      })
    ]
    await renderDialog()

    expect(sourceSwitch('/srv/team-worktrees').getAttribute('aria-checked')).toBe('false')
    const remove = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove /srv/team-worktrees"]'
    )
    expect(remove).not.toBeNull()
    await click(remove!)

    expect(mocks.state.updateRepo).toHaveBeenCalledWith(
      'repo-1',
      expect.objectContaining({
        customWorktreeVisibilitySources: [],
        worktreeVisibilitySourcePreferences: expect.not.objectContaining({
          custom: expect.objectContaining({ team: expect.anything() })
        })
      })
    )
    expect(mocks.state.closeModal).not.toHaveBeenCalled()
  })

  it('rejects removal success when an older host leaves the custom preference behind', async () => {
    const repo = makeRepo({
      customWorktreeVisibilitySources: [{ id: 'team', rootPath: '/srv/team-worktrees' }],
      worktreeVisibilitySourcePreferences: { custom: { team: 'show' } }
    })
    mocks.state.repos = [repo]
    mocks.state.updateRepo.mockImplementation(async () => {
      repo.customWorktreeVisibilitySources = []
      return true
    })
    await renderDialog()
    mocks.state.fetchWorktrees.mockClear()

    await click(document.querySelector('button[aria-label="Remove /srv/team-worktrees"]')!)

    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'Could not update worktree visibility. Try again.'
    )
    expect(mocks.state.fetchWorktrees).not.toHaveBeenCalled()
  })

  it('uses full paths to distinguish custom source controls with the same basename', async () => {
    mocks.state.repos = [
      makeRepo({
        customWorktreeVisibilitySources: [
          { id: 'alpha', rootPath: '/srv/alpha/team' },
          { id: 'beta', rootPath: '/srv/beta/team' }
        ]
      })
    ]

    await renderDialog()

    expect(sourceSwitch('/srv/alpha/team')).not.toBeNull()
    expect(sourceSwitch('/srv/beta/team')).not.toBeNull()
    expect(document.querySelector('button[aria-label="Remove /srv/alpha/team"]')).not.toBeNull()
    expect(document.querySelector('button[aria-label="Remove /srv/beta/team"]')).not.toBeNull()
  })

  it('shows inherited global locations without repository removal controls', async () => {
    mocks.state.settings = {
      worktreeVisibilityDefaults: {
        external: 'hide',
        customSources: [{ id: 'global-team', rootPath: '/srv/global-team' }],
        sourcePreferences: { custom: { 'global-team': 'show' } }
      }
    }

    await renderDialog()

    expect(sourceSwitch('/srv/global-team').getAttribute('aria-checked')).toBe('true')
    expect(document.querySelector('button[aria-label="Remove /srv/global-team"]')).toBeNull()
    await click(sourceSegment('/srv/global-team', 'hide'))
    expect(mocks.state.updateRepo).toHaveBeenCalledWith('repo-1', {
      worktreeVisibilitySourcePreferences: { custom: { 'global-team': 'hide' } }
    })
  })

  it('resets global custom and Other locations without changing their global defaults', async () => {
    mocks.state.repos = [
      makeRepo({
        externalWorktreeVisibility: 'show',
        worktreeVisibilitySourcePreferences: { custom: { 'global-team': 'hide' } }
      })
    ]
    mocks.state.settings = {
      worktreeVisibilityDefaults: {
        external: 'hide',
        customSources: [{ id: 'global-team', rootPath: '/srv/global-team' }],
        sourcePreferences: { custom: { 'global-team': 'show' } }
      }
    }
    await renderDialog()

    expect(sourceRow('/srv/global-team').textContent).toContain('Overriding global setting: Show')
    expect(sourceRow('Other locations').textContent).toContain('Overriding global setting: Hide')
    await click(sourceSegment('/srv/global-team', 'show'))
    await click(sourceSegment('Other locations', 'hide'))

    expect(mocks.state.updateRepo).toHaveBeenCalledWith('repo-1', {
      worktreeVisibilitySourcePreferences: {}
    })
    expect(mocks.state.updateRepo).toHaveBeenCalledWith('repo-1', {
      externalWorktreeVisibility: null
    })
  })
})
