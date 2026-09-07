let readPermission: ((ptyId: string | null) => boolean) | null = null
export function installWorkspacePtyControlReader(read: (ptyId: string | null) => boolean): void {
  readPermission = read
}
export function canControlWorkspacePty(ptyId: string | null): boolean {
  return readPermission?.(ptyId) ?? true
}
