// Why a leaf module: this constant only reads navigator.userAgent, but it used to live in
// new-workspace.ts, whose import graph dragged the whole store chain into any test that
// wanted the platform (and forced vi.resetModules() re-imports past their timeouts).
export const CLIENT_PLATFORM: NodeJS.Platform = navigator.userAgent.includes('Windows')
  ? 'win32'
  : navigator.userAgent.includes('Mac')
    ? 'darwin'
    : 'linux'
