/** Single origin label shared by renderer breadcrumb recording and snapshots. */
export function rendererCrashBreadcrumbOrigin(webContentsId: number): string {
  return `renderer:${webContentsId}`
}
