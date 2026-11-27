import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'

export const WorktreeParam = lazyZodSchema(() =>
  z.object({ worktree: z.string().optional() }).partial()
)

export const TapParams = lazyZodSchema(() =>
  z.object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    device: z.string().optional(),
    emulator: z.string().optional(),
    worktree: z.string().optional()
  })
)

export const GesturePoint = lazyZodSchema(() =>
  z.object({
    edge: z.number().int().min(0).max(4).optional(),
    type: z.enum(['begin', 'move', 'end']),
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1)
  })
)

export const GestureParams = lazyZodSchema(() =>
  z.object({
    points: z.array(GesturePoint).min(2).max(64),
    device: z.string().optional(),
    emulator: z.string().optional(),
    worktree: z.string().optional()
  })
)

export const TypeParams = lazyZodSchema(() =>
  z.object({
    text: z.string(),
    // The pane's paste: one pasteboard insert that keeps newlines as text.
    paste: z.boolean().optional(),
    device: z.string().optional(),
    emulator: z.string().optional(),
    worktree: z.string().optional()
  })
)

export const ButtonParams = lazyZodSchema(() =>
  z.object({
    name: z.string(),
    device: z.string().optional(),
    emulator: z.string().optional(),
    worktree: z.string().optional()
  })
)

export const RotateOrientation = lazyZodSchema(() =>
  z.enum(['portrait', 'portrait_upside_down', 'landscape_left', 'landscape_right'])
)

export const RotateParams = lazyZodSchema(() =>
  z.object({
    orientation: RotateOrientation,
    device: z.string().optional(),
    emulator: z.string().optional(),
    worktree: z.string().optional()
  })
)

export const ExecParams = lazyZodSchema(() =>
  z.object({
    command: z.string(),
    device: z.string().optional(),
    emulator: z.string().optional(),
    worktree: z.string().optional()
  })
)

export const LaunchParams = lazyZodSchema(() =>
  z.object({
    package: z.string(),
    activity: z.string().optional(),
    device: z.string().optional(),
    emulator: z.string().optional(),
    worktree: z.string().optional()
  })
)

export const PermissionsParams = lazyZodSchema(() =>
  z
    .object({
      op: z.enum(['grant', 'revoke', 'reset']),
      package: z.string().optional(),
      permission: z.string().optional(),
      device: z.string().optional(),
      emulator: z.string().optional(),
      worktree: z.string().optional()
    })
    .superRefine((value, ctx) => {
      if (value.op === 'reset') {
        if (value.package) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['package'],
            message: 'package is not allowed for reset'
          })
        }
        if (value.permission) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['permission'],
            message: 'permission is not allowed for reset'
          })
        }
        return
      }
      if (!value.package) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['package'],
          message: 'package is required for grant/revoke'
        })
      }
      if (!value.permission) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['permission'],
          message: 'permission is required for grant/revoke'
        })
      }
    })
)

export const AxParams = lazyZodSchema(() =>
  z.object({
    device: z.string().optional(),
    emulator: z.string().optional(),
    worktree: z.string().optional()
  })
)

export const LogcatParams = lazyZodSchema(() =>
  z.object({
    lines: z.number().int().positive().optional(),
    filters: z.array(z.string()).optional(),
    device: z.string().optional(),
    emulator: z.string().optional(),
    worktree: z.string().optional()
  })
)

export const AttachParams = lazyZodSchema(() =>
  z.object({
    userInitiated: z.boolean().optional(),
    device: z.string().optional(),
    worktree: z.string().optional(),
    focus: z.boolean().optional()
  })
)

export const KillParams = lazyZodSchema(() =>
  z.object({
    device: z.string().optional(),
    emulator: z.string().optional(),
    worktree: z.string().optional()
  })
)

export const ShutdownParams = lazyZodSchema(() =>
  KillParams.extend({
    managedOnly: z.boolean().optional()
  })
)

export const ListParams = WorktreeParam

export const EmulatorUnregisterActiveParams = lazyZodSchema(() =>
  z.object({ worktree: z.string().optional() }).partial()
)

export const EmulatorListDevicesParams = lazyZodSchema(() =>
  z.object({ worktree: z.string().optional() }).partial()
)

export const EmulatorAvailabilityParams = lazyZodSchema(() =>
  z.object({ worktree: z.string().optional() }).partial()
)

export const EmulatorListSimulatorsParams = lazyZodSchema(() =>
  z.object({ worktree: z.string().optional() }).partial()
)
