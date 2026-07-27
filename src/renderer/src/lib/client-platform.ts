/**
 * Platform of the machine running this renderer.
 *
 * Why: kept in its own leaf module so PATH/runtime-sensitive code (agent launch
 * platform, detected-executable publishing) can read it without importing
 * `new-workspace`, which pulls in the whole Zustand store.
 */
export const CLIENT_PLATFORM: NodeJS.Platform = navigator.userAgent.includes('Windows')
  ? 'win32'
  : navigator.userAgent.includes('Mac')
    ? 'darwin'
    : 'linux'
