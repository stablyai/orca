import { z } from 'zod'
import { CONNECTOR_SOURCES } from '../external-conversation-link'
import { AgentLaunchFields } from './agent-launch-params'

const ConnectorDelivery = {
  source: z.enum(CONNECTOR_SOURCES),
  externalId: z.string().min(1, 'Missing external conversation id'),
  /** The caller's id for this delivery; a retry with the same id and payload shares its answer. */
  deliveryId: z.string().min(1, 'Missing delivery id')
}

export const ConnectorStart = z.object({
  ...ConnectorDelivery,
  /** Admitted by the host's connector agent list, so an unsupported one is a refusal, not invalid. */
  agent: z.string().min(1, 'Missing agent'),
  target: AgentLaunchFields.shape.target,
  prompt: z.string().min(1, 'Missing prompt')
})

export const ConnectorSend = z.object({
  ...ConnectorDelivery,
  text: z.string().min(1, 'Missing text')
})
