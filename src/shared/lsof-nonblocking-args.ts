// Why: without -b, lsof stat()s every mount in a forked helper, and a dead network mount blocks
// that call in the kernel, leaving an unkillable helper process behind on every scan. -w hides the
// "can't stat()" warnings -b prints. Only for queries that name no file: with -b, lsof rejects
// file arguments such as `-U <path>` or `+D <dir>`.
export const LSOF_NONBLOCKING_ARGS = ['-b', '-w'] as const
