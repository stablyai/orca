import { z } from 'zod'

import { RoomId } from './rooms-schemas'

export const RoomsWorkStopParams = z.object({ roomId: RoomId }).strict()

export const RoomsWorkResumeParams = z.object({ roomId: RoomId }).strict()
