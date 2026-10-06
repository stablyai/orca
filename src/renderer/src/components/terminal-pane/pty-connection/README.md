# PTY connection lifecycle

Connects terminal panes to local and remote PTY transports.

- `connect-pane-pty-session.ts`: state shared across connection stages.
- `pty-input-recovery.ts`: transport setup, capability replies and failed-input recovery.
- `pty-viewport-claims.ts`: visible desktop claims on remote viewports.
- Sibling modules handle attach, stream delivery and restored-pane startup.

Transport implementations live in the parent terminal-pane directory.
