import { z } from 'zod'

// Minimal schemas for emulator commands (loose for initial testing; can be tightened like browser-schemas).
export const WorktreeParam = z.object({ worktree: z.string().optional() }).partial()

export const TapParams = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  device: z.string().optional(),
  emulator: z.string().optional(),
  worktree: z.string().optional()
})

export const GesturePoint = z.object({
  edge: z.number().int().min(0).max(4).optional(),
  type: z.enum(['begin', 'move', 'end']),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1)
})

export const GestureParams = z.object({
  points: z.array(GesturePoint).min(2).max(64),
  device: z.string().optional(),
  emulator: z.string().optional(),
  worktree: z.string().optional()
})

export const TypeParams = z.object({
  text: z.string(),
  device: z.string().optional(),
  emulator: z.string().optional(),
  worktree: z.string().optional()
})

export const ButtonParams = z.object({
  name: z.string(),
  device: z.string().optional(),
  emulator: z.string().optional(),
  worktree: z.string().optional()
})

export const RotateOrientation = z.enum([
  'portrait',
  'portrait_upside_down',
  'landscape_left',
  'landscape_right'
])

export const RotateParams = z.object({
  orientation: RotateOrientation,
  device: z.string().optional(),
  emulator: z.string().optional(),
  worktree: z.string().optional()
})

export const ExecParams = z.object({
  command: z.string(),
  device: z.string().optional(),
  emulator: z.string().optional(),
  worktree: z.string().optional()
})

export const LaunchParams = z.object({
  package: z.string(),
  activity: z.string().optional(),
  device: z.string().optional(),
  emulator: z.string().optional(),
  worktree: z.string().optional()
})

export const PermissionsParams = z
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

export const AxParams = z.object({
  device: z.string().optional(),
  emulator: z.string().optional(),
  worktree: z.string().optional()
})

export const LogcatParams = z.object({
  lines: z.number().int().positive().optional(),
  filters: z.array(z.string()).optional(),
  device: z.string().optional(),
  emulator: z.string().optional(),
  worktree: z.string().optional()
})

export const AttachParams = z.object({
  device: z.string().optional(),
  worktree: z.string().optional(),
  focus: z.boolean().optional()
})

export const KillParams = z.object({
  device: z.string().optional(),
  emulator: z.string().optional(),
  worktree: z.string().optional()
})

export const ShutdownParams = KillParams.extend({
  managedOnly: z.boolean().optional()
})

export const ListParams = WorktreeParam

export const EmulatorUnregisterActiveParams = z
  .object({ worktree: z.string().optional() })
  .partial()

export const EmulatorListDevicesParams = z.object({ worktree: z.string().optional() }).partial()

export const EmulatorAvailabilityParams = z.object({ worktree: z.string().optional() }).partial()

export const EmulatorListSimulatorsParams = z.object({ worktree: z.string().optional() }).partial()

export const AdbConnectParams = z.object({
  address: z.string().min(1),
  worktree: z.string().optional()
})

export const AdbAddressOptionalParams = z.object({
  address: z.string().min(1).optional(),
  worktree: z.string().optional()
})
