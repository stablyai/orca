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
            { kind: 'wsl-authored-worktrees', repoId: 'r1', paths: ['/mnt/c/src/fix'] }
          ]
        },
        String.raw`C:\src\app`
      )
    ).toEqual([
      String.raw`C:\src\app is already a project in Orca.`,
      expect.stringContaining('/mnt/c/src/fix')
    ])
    expect(
      wslDriveUncConversionMessages({ outcome: 'terminals-blocked', blockers: [] }, 'C:\\x')[0]
    ).toContain('busy')
  })
})
