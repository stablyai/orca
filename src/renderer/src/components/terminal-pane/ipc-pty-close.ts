export function closeIpcPty(id: string, retire: () => void): void {
  void window.api.pty
    .kill(id)
    ?.then(retire)
    .catch((error) => console.warn('[pty-transport] could not close terminal', error))
}
