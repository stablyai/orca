import * as z from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import { OptionalString, requiredString } from '../rpc-param-primitives'
import { TERMINAL_PANE_SPLIT_SOURCES } from '../../feature-education/feature-education-telemetry'
import { TerminalCreateParams, TerminalHandle } from './terminal-unary-params'

export const TerminalSplit = lazyZodSchema(() =>
  z
    .object({
      // Required unless `pane` names the source; the refinement keeps the handle's message.
      terminal: OptionalString,
      expectedIncarnationId: TerminalHandle.shape.expectedIncarnationId,
      direction: z
        .unknown()
        .transform((v) => (v === 'vertical' || v === 'horizontal' ? v : undefined))
        .pipe(z.union([z.enum(['vertical', 'horizontal']), z.undefined()]))
        .optional(),
      command: OptionalString,
      env: z.record(z.string(), z.string()).optional(),
      keepOpen: TerminalCreateParams.shape.keepOpen,
      telemetrySource: z.enum(TERMINAL_PANE_SPLIT_SOURCES).optional(),
      // Timed-out split identity, gated on TERMINAL_SPLIT_RETRY_RUNTIME_CAPABILITY; reject blank rather than treating it as a fresh split.
      retrySplit: z.string().min(1, 'Missing split id').optional(),
      // Layout-owner build: a window names its own pane; main writes the split and starts it.
      pane: z
        .object({
          worktreeId: requiredString('Missing worktree'),
          tabId: requiredString('Missing tab'),
          leafId: requiredString('Missing pane')
        })
        .optional(),
      newLeafId: OptionalString,
      cwd: OptionalString,
      initialSize: z
        .object({
          cols: z.number().int().min(1).max(1000),
          rows: z.number().int().min(1).max(500)
        })
        .optional()
    })
    .superRefine((params, ctx) => {
      if (!params.terminal && !params.pane) {
        ctx.addIssue({ code: 'custom', message: 'Missing terminal handle', path: ['terminal'] })
      }
    })
)
