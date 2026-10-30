import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  resolveProjectExecutionRuntime,
  type LocalWindowsRuntimePreference
} from '../../../../shared/project-execution-runtime'
import { WslDriveProjectGitRow } from './WslDriveProjectGitRow'
import { wslDriveProjectBlockerMessage } from './wsl-drive-project-copy'

function render(preference: LocalWindowsRuntimePreference, repoPath = String.raw`C:\src\app`) {
  return renderToStaticMarkup(
    <WslDriveProjectGitRow
      projectId="p1"
      repoPath={repoPath}
      resolution={resolveProjectExecutionRuntime({
        appPlatform: 'win32',
        projectId: 'p1',
        projectRuntimePreference: preference
      })}
      updateProject={vi.fn()}
    />
  )
}

describe('WslDriveProjectGitRow', () => {
  it('offers Git for Windows to a WSL project on a Windows drive', () => {
    const html = render({ kind: 'wsl', distro: 'Ubuntu' })
    expect(html).toContain('Use Git for Windows')
    expect(html).toContain('terminals and agents stay in Ubuntu')
  })

  it('says where Git and terminals run once converted, with nothing to click', () => {
    const html = render({ kind: 'wsl', distro: 'Ubuntu', git: 'windows-host' })
    expect(html).toContain('Orca runs Git on Windows for this project')
    expect(html).not.toContain('<button')
  })

  it('shows nothing for a Windows project or a project inside the distro', () => {
    expect(render({ kind: 'windows-host' })).toBe('')
    expect(
      render({ kind: 'wsl', distro: 'Ubuntu' }, String.raw`\\wsl.localhost\Ubuntu\home\me\app`)
    ).toBe('')
  })

  it('names the WSL-made workspaces that block the switch', () => {
    expect(
      wslDriveProjectBlockerMessage({
        kind: 'wsl-authored-worktrees',
        repoId: 'r1',
        paths: ['/home/me/orca/workspaces/app/fix']
      })
    ).toContain('/home/me/orca/workspaces/app/fix')
  })
})
