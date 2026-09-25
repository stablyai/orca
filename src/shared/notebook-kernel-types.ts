/** A Python interpreter that can host a notebook kernel. */
export type PythonEnvironment = {
  /** Absolute interpreter path; the kernel runs in this interpreter's environment. */
  path: string
  /** `.venv`, `python3`, … — what the kernel picker shows first. */
  name: string
  version: string
}

export type PythonEnvironments = {
  /** `.venv`/`.conda` envs around the notebook, nearest first; the first is recommended. */
  workspace: PythonEnvironment[]
  /** Interpreters found on PATH. */
  path: PythonEnvironment[]
}

export type KernelStartResult =
  | { status: 'ready' }
  /** `externallyManaged`: pip refuses to install into it (PEP 668), so it needs a virtual environment. */
  | { status: 'missing-ipykernel'; externallyManaged: boolean }
  | { status: 'failed'; detail: string }

/** Kernel output message types the bridge forwards, named as in the Jupyter messaging protocol. */
export const KERNEL_OUTPUT_TYPES = [
  'stream',
  'display_data',
  'execute_result',
  'update_display_data',
  'clear_output',
  'error'
] as const
export type KernelOutputType = (typeof KERNEL_OUTPUT_TYPES)[number]

/** What a running kernel reports, in order, for the one execution in flight. */
export type KernelFrame =
  | { type: KernelOutputType; content: Record<string, unknown> }
  | { type: 'done'; status: string; execution_count: number | null }
  /** The kernel is gone; `detail` is the tail of its stderr. */
  | { type: 'exit'; detail: string }

export type CreateVenvResult =
  | { ok: true; environment: PythonEnvironment }
  | { ok: false; detail: string }

export type KernelFrameEvent = { filePath: string; frame: KernelFrame }
