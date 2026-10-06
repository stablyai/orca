# Renderer hooks

Connects renderer lifecycle and UI events to application state.

- `ipc-events/`: desktop event bridges, including terminal presentation and startup requests.
- `ipc-events-terminal-create-*`: shared fixtures for terminal event tests.

Terminal startup queues belong to [store slices](../store/slices/README.md); launch and recovery orchestration belongs to [renderer libraries](../lib/README.md).
