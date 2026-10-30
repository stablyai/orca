import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { WslDriveUncConversionRow } from './WslDriveUncConversionRow'
import { wslDriveUncConversionMessages } from './wsl-drive-unc-conversion-copy'

const render = (path: string) =>
  renderToStaticMarkup(<WslDriveUncConversionRow repo={{ id: 'r1', path }} />)

describe('WslDriveUncConversionRow', () => {
  it('offers the drive path to a project opened through WSL on a Windows drive', () => {
    const html = render(String.raw`\\wsl.localhost\Ubuntu\mnt\c\src\app`)
    expect(html).toContain(String.raw`Open at C:\src\app`)
    expect(html).toContain('terminals and agents stay in Ubuntu')
  })

  it('shows nothing for a project inside the distro or already on a drive', () => {
    expect(render(String.raw`\\wsl.localhost\Ubuntu\home\me\app`)).toBe('')
    expect(render(String.raw`C:\src\app`)).toBe('')
  })

  it('explains each refusal in plain words', () => {
    expect(
      wslDriveUncConversionMessages(
        {
          outcome: 'refused',
          blockers: [
            { kind: 'not-convertible', id: 'r1', reason: 'duplicate-windows-project' },
            { kind: 'not-convertible', id: 'r1', reason: 'not-windows-drive-mount' },
            { kind: 'wsl-authored-worktrees', repoId: 'r1', paths: ['/mnt/c/src/fix'] }
          ]
        },
        String.raw`C:\src\app`
      )
    ).toEqual([
      String.raw`C:\src\app is already a project in Orca.`,
      String.raw`In this distro, that folder isn’t C:\src\app: it isn’t mounted from that Windows drive.`,
      expect.stringContaining('/mnt/c/src/fix')
    ])
    expect(
      wslDriveUncConversionMessages({ outcome: 'terminals-blocked', blockers: [] }, 'C:\\x')[0]
    ).toContain('busy')
  })

  it('names why saved state blocks the conversion', () => {
    const conflict = (cause?: 'project-split' | 'differing-saved-data') =>
      wslDriveUncConversionMessages(
        {
          outcome: 'refused',
          blockers: [{ kind: 'state-conflict', detail: 'x', ...(cause ? { cause } : {}) }]
        },
        String.raw`C:\src\app`
      )[0]
    expect(conflict('differing-saved-data')).toContain(String.raw`its WSL path and C:\src\app`)
    expect(conflict('project-split')).toContain('isn’t converting')
    expect(conflict()).toContain('can’t convert safely')
  })
})
