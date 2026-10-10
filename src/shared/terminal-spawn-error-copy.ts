// Host-published English copy; the renderer matches it to show a translation (#9194).
export const PTY_ALLOCATION_HINT =
  'Your system cannot allocate any more pty devices. Close some terminals you are not using, in Orca or another program, then try again.'

export const TERMINAL_PROCESS_LIMIT_HINT =
  'Your system cannot start another terminal process. Close unused terminals or quit unused processes, then try again.'

// Older hosts still publish these multi-line forms.
export const LEGACY_PTY_ALLOCATION_HINT = [
  'Your system cannot allocate any more pty devices.',
  '',
  'Orca requires a pty device to launch a new terminal. This error is usually due to having too many terminal windows or terminal sessions open, either in Orca or another program.',
  '',
  'Free up some pty devices and try again.'
].join('\n')

export const LEGACY_TERMINAL_PROCESS_LIMIT_HINT = [
  'Your system cannot start another terminal process.',
  '',
  'This is usually due to having too many terminal sessions or other processes running.',
  '',
  'Close unused terminals or quit unused processes and try again.'
].join('\n')

export const TERMINAL_SPAWN_ISSUE_REQUEST = 'If this persists, please file an issue.'
