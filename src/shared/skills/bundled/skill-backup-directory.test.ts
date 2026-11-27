import { posix, win32 } from 'node:path'
import { describe, expect, it } from 'vitest'
import { collapseHomePath, skillBackupDirectory } from './bundled-skill-locations'

// The named folder must be the one the executor creates on that host (join on the host's own OS),
// whichever OS the client runs, and must never mix separators.
describe('skillBackupDirectory', () => {
  it.each(['/home/dev', '/home/dev/', '/Users/a b'])(
    'matches a POSIX host executor for %s',
    (home) => {
      const folder = skillBackupDirectory(home)
      expect(folder).toBe(posix.join(home, '.agents', '.orca-skill-backups'))
      expect(folder).not.toContain('\\')
      expect(collapseHomePath(folder, home)).toBe('~/.agents/.orca-skill-backups')
    }
  )

  it.each(['C:\\Users\\dev', 'c:\\Users\\dev\\', '\\\\server\\share\\dev'])(
    'matches a Windows host executor for %s',
    (home) => {
      const folder = skillBackupDirectory(home)
      expect(folder).toBe(win32.join(home, '.agents', '.orca-skill-backups'))
      expect(folder.slice(home.replace(/\\+$/u, '').length)).not.toContain('/')
      expect(collapseHomePath(folder, home)).toBe('~\\.agents\\.orca-skill-backups')
    }
  )
})
