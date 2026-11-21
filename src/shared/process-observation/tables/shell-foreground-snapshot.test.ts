import { expect, it } from 'vitest'

import './process-table-snapshot-reader'
import { parseShellForegroundRows } from './process-table-snapshot'
import '../darwin/darwin-terminal-names'

// With no `tty=` column to absorb them, the shared parser read `python`/`3` as tty/start.
it('keeps an argv whose second token is numeric', () => {
  expect(parseShellForegroundRows('101 100 101 101 S+ /usr/bin/python 3 app.py')).toEqual([
    { pid: 101, ppid: 100, pgid: 101, tpgid: 101, stat: 'S+', command: '/usr/bin/python 3 app.py' }
  ])
})
