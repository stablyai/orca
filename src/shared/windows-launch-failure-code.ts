// Chromium's sandbox broker refuses a child launch with a `sandbox::ResultCode`, and
// Electron surfaces that value as `exitCode` when `reason` is 'launch-failed'. That is a
// DIFFERENT namespace from a process exit status: 18 here is SBOX_ERROR_CREATE_PROCESS,
// while 18 from a process that actually ran is plain exit(18). Decode for display only —
// the raw value stays the stored source of truth, exactly as windows-crash-exit-code.ts does.
//
// Transcribed from sandbox/win/src/sandbox_types.h at Chromium 150.0.7871.250 (the version
// Electron 43.7.0 pins; sha256 df03c0510815b9d536936976cde5eb0cb6dd0518182d1d934b8074659c3c1abc).
// The header declares the enum append-only — "These codes are listed in a histogram and any new
// codes should be added at the end" — so a code added by a later Chromium lands past this table
// and degrades to the raw number rather than borrowing a neighbour's name.

export type WindowsLaunchFailureDecode = {
  code: number
  /** The Chromium enum member, which is what an upstream bug report will be filed against. */
  name: string
  description: string
}

// Why a name AND a description: the enum member is the searchable token, the prose is what
// makes the report readable without a Chromium checkout to hand.
const SANDBOX_RESULT_CODES: Record<number, readonly [string, string]> = {
  1: ['SBOX_ERROR_GENERIC', 'generic win32-layer error'],
  2: ['SBOX_ERROR_BAD_PARAMS', 'an invalid combination of parameters was given to the API'],
  3: ['SBOX_ERROR_UNSUPPORTED', 'the desired operation is not supported at this time'],
  4: ['SBOX_ERROR_NO_SPACE', 'the request requires more memory that allocated or available'],
  5: ['SBOX_ERROR_INVALID_IPC', 'the ipc service requested does not exist'],
  6: ['SBOX_ERROR_FAILED_IPC', 'the ipc service did not complete'],
  7: ['SBOX_ERROR_NO_HANDLE', 'the requested handle was not found'],
  8: ['SBOX_ERROR_UNEXPECTED_CALL', 'this function was not expected to be called at this time'],
  9: ['SBOX_ERROR_WAIT_ALREADY_CALLED', 'WaitForAllTargets is already called'],
  10: ['SBOX_ERROR_CHANNEL_ERROR', 'a channel error prevented DoCall from executing'],
  11: ['SBOX_ERROR_CANNOT_CREATE_DESKTOP', 'failed to create the alternate desktop'],
  12: ['SBOX_ERROR_CANNOT_CREATE_WINSTATION', 'failed to create the alternate window station'],
  13: [
    'SBOX_ERROR_FAILED_TO_SWITCH_BACK_WINSTATION',
    'failed to switch back to the interactive window station'
  ],
  14: ['SBOX_ERROR_INVALID_APP_CONTAINER', 'the supplied AppContainer is not valid'],
  15: ['SBOX_ERROR_INVALID_CAPABILITY', 'the supplied capability is not valid'],
  16: ['SBOX_ERROR_CANNOT_INIT_APPCONTAINER', 'there is a failure initializing the AppContainer'],
  17: ['SBOX_ERROR_PROC_THREAD_ATTRIBUTES', 'initializing or updating ProcThreadAttributes failed'],
  18: ['SBOX_ERROR_CREATE_PROCESS', 'error in creating process'],
  19: ['SBOX_ERROR_DELEGATE_PRE_SPAWN', 'failure calling delegate PreSpawnTarget'],
  20: ['SBOX_ERROR_ASSIGN_PROCESS_TO_JOB_OBJECT', 'could not assign process to job object'],
  21: ['SBOX_ERROR_SET_THREAD_TOKEN', 'could not assign initial thread token'],
  22: ['SBOX_ERROR_GET_THREAD_CONTEXT', 'could not get thread context of new process'],
  23: ['SBOX_ERROR_DUPLICATE_TARGET_INFO', 'could not duplicate target info of new process'],
  24: ['SBOX_ERROR_SET_LOW_BOX_TOKEN', 'could not set low box token'],
  25: ['SBOX_ERROR_CREATE_FILE_MAPPING', 'could not create file mapping for IPC dispatcher'],
  26: [
    'SBOX_ERROR_DUPLICATE_SHARED_SECTION',
    'could not duplicate shared section into target process for IPC dispatcher'
  ],
  27: ['SBOX_ERROR_MAP_VIEW_OF_SHARED_SECTION', 'could not map view of shared memory in broker'],
  28: ['SBOX_ERROR_APPLY_ASLR_MITIGATIONS', 'could not apply ASLR mitigations to target process'],
  29: [
    'SBOX_ERROR_SETUP_BASIC_INTERCEPTIONS',
    'could not setup one of the required interception services'
  ],
  30: ['SBOX_ERROR_SETUP_INTERCEPTION_SERVICE', 'could not setup basic interceptions'],
  31: [
    'SBOX_ERROR_INITIALIZE_INTERCEPTIONS',
    'could not initialize interceptions, often 3rd-party hooks'
  ],
  32: ['SBOX_ERROR_SETUP_NTDLL_IMPORTS', 'could not setup the imports for ntdll in target process'],
  33: ['SBOX_ERROR_SETUP_HANDLE_CLOSER', 'could not setup the handle closer in target process'],
  34: ['SBOX_ERROR_CANNOT_GET_WINSTATION', 'cannot get the current Window Station'],
  35: [
    'SBOX_ERROR_CANNOT_QUERY_WINSTATION_SECURITY',
    'cannot query the security attributes of the current Window Station'
  ],
  36: ['SBOX_ERROR_CANNOT_GET_DESKTOP', 'cannot get the current Desktop'],
  37: [
    'SBOX_ERROR_CANNOT_QUERY_DESKTOP_SECURITY',
    'cannot query the security attributes of the current Desktop'
  ],
  38: [
    'SBOX_ERROR_CANNOT_SETUP_INTERCEPTION_CONFIG_BUFFER',
    'cannot setup the interception manager config buffer'
  ],
  39: ['SBOX_ERROR_CANNOT_COPY_DATA_TO_CHILD', 'cannot copy data to the child process'],
  40: ['SBOX_ERROR_CANNOT_SETUP_INTERCEPTION_THUNK', 'cannot setup the interception thunk'],
  41: ['SBOX_ERROR_CANNOT_RESOLVE_INTERCEPTION_THUNK', 'cannot resolve the interception thunk'],
  42: [
    'SBOX_ERROR_CANNOT_WRITE_INTERCEPTION_THUNK',
    'cannot write interception thunk to child process'
  ],
  43: ['SBOX_ERROR_CANNOT_FIND_BASE_ADDRESS', 'cannot find the base address of the new process'],
  44: ['SBOX_ERROR_CREATE_APPCONTAINER', 'cannot create the AppContainer profile'],
  45: [
    'SBOX_ERROR_CREATE_APPCONTAINER_ACCESS_CHECK',
    "cannot create the AppContainer as the main executable can't be accessed"
  ],
  46: [
    'SBOX_ERROR_CREATE_APPCONTAINER_CAPABILITY',
    'cannot create the AppContainer as adding a capability failed'
  ],
  47: ['SBOX_ERROR_CANNOT_INIT_JOB', 'cannot initialize a job object'],
  48: ['SBOX_ERROR_INVALID_LOWBOX_SID', 'invalid LowBox SID string'],
  49: ['SBOX_ERROR_CANNOT_CREATE_RESTRICTED_TOKEN', 'cannot create restricted token'],
  50: [
    'SBOX_ERROR_CANNOT_SET_DESKTOP_INTEGRITY',
    'cannot set the integrity level on a desktop object'
  ],
  51: ['SBOX_ERROR_CANNOT_CREATE_LOWBOX_TOKEN', 'cannot create a LowBox token'],
  52: ['SBOX_ERROR_CANNOT_MODIFY_LOWBOX_TOKEN_DACL', "cannot modify LowBox token's DACL"],
  53: [
    'SBOX_ERROR_CANNOT_CREATE_RESTRICTED_IMP_TOKEN',
    'cannot create restricted impersonation token'
  ],
  54: ['SBOX_ERROR_CANNOT_DUPLICATE_PROCESS_HANDLE', 'cannot duplicate target process handle'],
  55: ['SBOX_ERROR_CANNOT_LOADLIBRARY_EXECUTABLE', 'cannot load executable for variable transfer'],
  56: ['SBOX_ERROR_CANNOT_FIND_VARIABLE_ADDRESS', 'cannot find variable address for transfer'],
  57: ['SBOX_ERROR_CANNOT_WRITE_VARIABLE_VALUE', 'cannot write variable value'],
  58: ['SBOX_ERROR_INVALID_WRITE_VARIABLE_SIZE', 'short write to variable'],
  59: ['SBOX_ERROR_CANNOT_INIT_BROKERSERVICES', 'cannot initialize BrokerServices'],
  60: ['SBOX_ERROR_CANNOT_UPDATE_JOB_PROCESS_LIMIT', 'cannot update job active process limit'],
  61: [
    'SBOX_ERROR_CANNOT_CREATE_LOWBOX_IMPERSONATION_TOKEN',
    'cannot create an impersonation lowbox token'
  ],
  63: ['SBOX_ERROR_CANNOT_LAUNCH_UNSANDBOXED_PROCESS', 'could not create the unsandboxed process'],
  64: ['SBOX_ERROR_INVALID_LINK_STATE', 'sandbox code hosted outside the main EXE'],
  65: [
    'SBOX_ERROR_INVALID_TARGET_BASE_ADDRESS',
    "target EXE base address differs from the broker's"
  ],
  66: ['SBOX_ERROR_CANNOT_READ_SENTINEL_VALUE', 'the target process sentinel value cannot be read'],
  67: ['SBOX_ERROR_INVALID_READ_SENTINEL_SIZE', 'short read of the target process sentinel value'],
  68: [
    'SBOX_ERROR_MISMATCH_SENTINEL_VALUE',
    'the target process sentinel value did not match the sentinel in the broker'
  ],
  69: [
    'SBOX_ERROR_FAILED_TO_FREEZE_CONFIG',
    'the process of consolidating the ConfigBase for a policy failed'
  ],
  70: [
    'SBOX_ERROR_CANNOT_OBTAIN_ENVIRONMENT',
    'unable to obtain the environment in the broker process'
  ],
  71: ['SBOX_ERROR_DELEGATE_INITIALIZE_CONFIG', 'unable to initialize the target configuration'],
  72: ['SBOX_ERROR_DISABLING_APPHELP', "failed to disable apphelp in the child's PEB"]
}

// content/browser/child_process_launcher.h. Deliberately disjoint from the sandbox range
// above — Chromium asserts `LAUNCH_RESULT_START > SBOX_ERROR_LAST` on Windows — so one
// lookup over both cannot collide.
// Only the failure member: START (1001) is a range sentinel and SUCCESS (1002) contradicts
// launch-failed outright, so both are excluded for the same reason SBOX_ALL_OK is.
const LAUNCH_RESULT_CODES: Record<number, readonly [string, string]> = {
  1003: ['LAUNCH_RESULT_FAILURE', 'generic launch failure with no sandbox stage recorded']
}

/**
 * Decode a win32 `launch-failed` exit code, or null when it is not one we can name.
 *
 * Deliberately absent, on one rule — never name a code that would mislead: SBOX_ALL_OK (0) and
 * LAUNCH_RESULT_SUCCESS (1002) both contradict launch-failed, LAUNCH_RESULT_START (1001) is a
 * range sentinel, and SBOX_ERROR_UNSANDBOXED_PROCESS (62) is sandbox_win.h's documented "this
 * process should be run unsandboxed" status rather than a fault — and is in any case unreachable
 * from the pinned Chromium's launch path, which decides that before it generates a policy.
 */
export function decodeWindowsLaunchFailureCode(
  exitCode: number
): WindowsLaunchFailureDecode | null {
  // No `>>> 0` normalization here, unlike windows-crash-exit-code.ts. ToUint32 wraps rather
  // than rejects, so it would name real stages for inputs that are not codes at all:
  // `1.5 >>> 0` is 1 (SBOX_ERROR_GENERIC) and `-4294967278 >>> 0` is 18 (CREATE_PROCESS).
  //
  // This guard and that missing coercion are each individually a no-op — the object lookup
  // already misses on a negative or fractional key — so changing either one alone is
  // undetectable. Removing BOTH is the regression, and it is the likely one: adding the
  // coercion makes this guard look dead. Do not "prove" it dead; the test file pins the pair.
  if (!Number.isInteger(exitCode) || exitCode < 0) {
    return null
  }
  const entry = SANDBOX_RESULT_CODES[exitCode] ?? LAUNCH_RESULT_CODES[exitCode]
  return entry === undefined ? null : { code: exitCode, name: entry[0], description: entry[1] }
}

/** Renders as `SBOX_ERROR_CREATE_PROCESS, error in creating process`. */
export function describeWindowsLaunchFailureCode(decode: WindowsLaunchFailureDecode): string {
  // No hex spelling, unlike the NTSTATUS table: these are small decimal enum members, and a
  // hex-padded launch code reads to a triager as an NTSTATUS from an entirely different space.
  return `${decode.name}, ${decode.description}`
}
